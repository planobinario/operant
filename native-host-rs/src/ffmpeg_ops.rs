use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use serde_json::{json, Value};

use crate::protocol::MessageSender;
use crate::tools::{create_no_window_cmd, detect, download_file_with_progress, output_dir};

pub fn looks_like_real_media(path: &Path) -> bool {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if meta.len() < 1024 {
        return false;
    }
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut head = [0u8; 64];
    let n = f.read(&mut head).unwrap_or(0);
    if n >= 7 && head.starts_with(b"#EXTM3U") {
        return false;
    }
    let s = String::from_utf8_lossy(&head[..n]);
    let trimmed = s.trim_start();
    if trimmed.starts_with('<') || trimmed.starts_with('{') {
        return false;
    }
    if !head.starts_with(b"\x00\x00\x00") {
        return false;
    }

    let mut sample = vec![0u8; 262144];
    let sample_read = f.read(&mut sample).unwrap_or(0);
    let sample_slice = &sample[..sample_read];

    let has_mdat = sample_slice.windows(4).any(|w| w == b"mdat");
    let has_moof = sample_slice.windows(4).any(|w| w == b"moof");
    has_mdat || has_moof
}

pub fn probe_duration(ffmpeg_path: &Path, src: &str) -> Option<f64> {
    let probe_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    let probe_path = ffmpeg_path.parent()?.join(probe_name);
    let probe_bin = if probe_path.is_file() {
        probe_path
    } else {
        crate::tools::find_in_path("ffprobe")?
    };

    let mut cmd = create_no_window_cmd(&probe_bin);
    cmd.args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    raw.parse::<f64>().ok()
}

pub fn run_ffmpeg_op(url: &str, op: &str, options: Value, sender: MessageSender) {
    let ffmpeg = match detect("ffmpeg") {
        Some(d) => d,
        None => {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": "ffmpeg no está instalado. Abre el panel -> Herramientas -> Instalar."
            }));
            return;
        }
    };

    let out_dir = output_dir();
    let _ = fs::create_dir_all(&out_dir);

    let clean_url = url.split('?').next().unwrap_or(url);
    let mut base_name = Path::new(clean_url)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();

    if let Some(pos) = base_name.rfind('.') {
        base_name.truncate(pos);
    }
    if base_name.is_empty() {
        base_name = "media".to_string();
    }

    if let Some(opt_fn) = options.get("filename").and_then(|v| v.as_str()) {
        let mut custom = Path::new(opt_fn).file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if let Some(pos) = custom.rfind('.') {
            custom.truncate(pos);
        }
        if !custom.is_empty() {
            base_name = custom;
        }
    }

    let temp_dir = tempfile::Builder::new()
        .prefix("operant-ffmpeg-")
        .tempdir();

    let workdir = match temp_dir {
        Ok(td) => td,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": format!("Error creando carpeta temporal: {}", e)
            }));
            return;
        }
    };

    let size_before;
    let duration;
    let out_ext;
    let mut cmd = create_no_window_cmd(&ffmpeg.path);
    cmd.arg("-y");

    if op == "dash-merge" {
        out_ext = "mp4";
        let video_url = options.get("videoUrl").and_then(|v| v.as_str()).unwrap_or(url);
        let audio_url = match options.get("audioUrl").and_then(|v| v.as_str()) {
            Some(a) if !a.is_empty() => a,
            _ => {
                let _ = sender.send(&json!({
                    "type": "ffmpeg-error",
                    "message": "Falta la URL de audio (DASH con track separado)."
                }));
                return;
            }
        };

        let src_v = workdir.path().join("video.mp4");
        let src_a = workdir.path().join("audio.mp4");

        let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 0 }));

        let s_clone = sender.clone();
        let _ = download_file_with_progress(video_url, &src_v, move |p| {
            let _ = s_clone.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": p / 2 }));
        });

        let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 50 }));

        let s_clone2 = sender.clone();
        let _ = download_file_with_progress(audio_url, &src_a, move |p| {
            let _ = s_clone2.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 50 + (p / 2) }));
        });

        let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));

        duration = probe_duration(&ffmpeg.path, &src_v.to_string_lossy());
        size_before = fs::metadata(&src_v).map(|m| m.len()).unwrap_or(0) + fs::metadata(&src_a).map(|m| m.len()).unwrap_or(0);

        cmd.args(["-i", &src_v.to_string_lossy(), "-i", &src_a.to_string_lossy(), "-c", "copy", "-movflags", "+faststart"]);
    } else if op == "hls-dash" {
        out_ext = "mp4";
        let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));
        duration = probe_duration(&ffmpeg.path, url);
        size_before = 0;
        cmd.args(["-i", url, "-c", "copy", "-movflags", "+faststart"]);
    } else {
        let ext = match op {
            "extract-mp3" => "mp3",
            "remux-mp4" | "compress" | "resize-50" => "mp4",
            "convert-webm" => "webm",
            "img-jpg" => "jpg",
            "img-webp" => "webp",
            _ => {
                let _ = sender.send(&json!({ "type": "ffmpeg-error", "message": format!("Operación desconocida: {}", op) }));
                return;
            }
        };
        out_ext = ext;

        let src_input = workdir.path().join("input.bin");
        let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 0 }));

        let s_clone = sender.clone();
        if let Err(e) = download_file_with_progress(url, &src_input, move |p| {
            let _ = s_clone.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": p }));
        }) {
            let _ = sender.send(&json!({ "type": "ffmpeg-error", "message": format!("Fallo descargando recurso: {}", e) }));
            return;
        }

        size_before = fs::metadata(&src_input).map(|m| m.len()).unwrap_or(0);
        let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));
        duration = probe_duration(&ffmpeg.path, &src_input.to_string_lossy());

        cmd.args(["-i", &src_input.to_string_lossy()]);

        match op {
            "extract-mp3" => { cmd.args(["-vn", "-c:a", "libmp3lame", "-b:a", "192k"]); }
            "remux-mp4" => { cmd.args(["-c", "copy", "-movflags", "+faststart"]); }
            "convert-webm" => { cmd.args(["-c:v", "libvpx", "-crf", "30", "-b:v", "2M", "-c:a", "libopus"]); }
            "compress" => {
                let crf = options.get("crf").and_then(|v| v.as_i64()).unwrap_or(28);
                cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", &crf.to_string(), "-c:a", "aac"]);
            }
            "resize-50" => { cmd.args(["-vf", "scale=iw*0.5:ih*0.5", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]); }
            "img-jpg" => { cmd.args(["-q:v", "2"]); }
            "img-webp" => { cmd.args(["-q:v", "75"]); }
            _ => {}
        }
    }

    let out_name = format!("{}_{}.{}", base_name, op, out_ext);
    let out_path = out_dir.join(&out_name);

    cmd.args(["-progress", "pipe:1", "-nostats", &out_path.to_string_lossy()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = sender.send(&json!({ "type": "ffmpeg-error", "message": format!("Error lanzando ffmpeg: {}", e) }));
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line_res in reader.lines() {
            if let Ok(line) = line_res {
                if let Some(rest) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = rest.trim().parse::<f64>() {
                        if let Some(dur) = duration {
                            if dur > 0.0 {
                                let pct = ((us / 1_000_000.0) / dur * 100.0).clamp(0.0, 99.0) as u32;
                                let _ = sender.send(&json!({
                                    "type": "ffmpeg-progress",
                                    "phase": "process",
                                    "progress": pct
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    let status = child.wait();
    match status {
        Ok(s) if s.success() => {
            let size_after = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
            let _ = sender.send(&json!({
                "type": "ffmpeg-done",
                "output": out_path.to_string_lossy(),
                "name": out_name,
                "sizeBefore": size_before,
                "sizeAfter": size_after
            }));
        }
        Ok(s) => {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": format!("ffmpeg terminó con error (código {:?}).", s.code())
            }));
        }
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": format!("Error esperando ffmpeg: {}", e)
            }));
        }
    }
}
