use std::fs;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use regex::Regex;
use serde_json::json;

use crate::protocol::MessageSender;
use crate::tools::{create_no_window_cmd, detect, output_dir};

pub fn list_formats(url: &str, sender: MessageSender) {
    let det = match detect("yt-dlp") {
        Some(d) => d,
        None => {
            let _ = sender.send(&json!({
                "type": "formats-error",
                "message": "yt-dlp no está instalado. Abre el panel -> Herramientas -> Instalar."
            }));
            return;
        }
    };

    let mut cmd = create_no_window_cmd(&det.path);
    cmd.args(["-F", "--no-download", url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "formats-error",
                "message": format!("Error al ejecutar yt-dlp: {}", e)
            }));
            return;
        }
    };

    if !output.status.success() {
        let _ = sender.send(&json!({
            "type": "formats-error",
            "message": format!("yt-dlp -F falló (código {:?}).", output.status.code())
        }));
        return;
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let mut formats = Vec::new();
    let num_re = Regex::new(r"^\d+$").unwrap();

    for line in stdout_str.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.starts_with("ID") || trimmed.starts_with('─') {
            continue;
        }
        let fields: Vec<&str> = trimmed.split_whitespace().collect();
        if fields.is_empty() || !num_re.is_match(fields[0]) {
            continue;
        }
        formats.push(json!({
            "id": fields[0],
            "ext": if fields.len() > 1 { fields[1] } else { "" },
            "note": trimmed
        }));
    }

    let _ = sender.send(&json!({
        "type": "formats",
        "url": url,
        "formats": formats
    }));
}

pub fn run_download(url: &str, format_id: Option<String>, sender: MessageSender) {
    let ytdl = match detect("yt-dlp") {
        Some(d) => d,
        None => {
            let _ = sender.send(&json!({
                "type": "error",
                "message": "yt-dlp no está instalado. Abre el panel -> Herramientas -> Instalar."
            }));
            return;
        }
    };

    if detect("ffmpeg").is_none() {
        let _ = sender.send(&json!({
            "type": "error",
            "message": "ffmpeg no está instalado (necesario para unir vídeo+audio). Panel -> Herramientas -> Instalar."
        }));
        return;
    }

    let out_dir = output_dir();
    let _ = fs::create_dir_all(&out_dir);

    let audio_only = format_id.as_deref().map(|f| f.to_lowercase().starts_with("bestaudio")).unwrap_or(false);
    let fmt_arg = format_id.map(|f| format!("-f{}", f)).unwrap_or_else(|| "-f bestvideo*+bestaudio/best".to_string());

    let template = out_dir.join("%(title).120s [%(id)s].%(ext)s").to_string_lossy().to_string();

    let mut cmd = create_no_window_cmd(&ytdl.path);
    cmd.arg(&fmt_arg)
        .arg("--newline")
        .arg("-o")
        .arg(&template)
        .arg(url);

    if audio_only {
        cmd.args(["-x", "--audio-format", "mp3", "--audio-quality", "0"]);
    } else {
        cmd.args(["--merge-output-format", "mp4"]);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "error",
                "message": format!("Error al lanzar yt-dlp: {}", e)
            }));
            return;
        }
    };

    let stdout = child.stdout.take();
    if let Some(out) = stdout {
        let reader = BufReader::new(out);
        let pct_re = Regex::new(r"\]\s*([0-9.]+)%").unwrap();

        for line_res in reader.lines() {
            if let Ok(line) = line_res {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let preview = if trimmed.len() > 300 { &trimmed[..300] } else { trimmed };
                let _ = sender.send(&json!({
                    "type": "progress",
                    "line": preview
                }));

                if trimmed.contains("[download]") && trimmed.contains('%') {
                    if let Some(caps) = pct_re.captures(trimmed) {
                        if let Some(pct_str) = caps.get(1) {
                            if let Ok(pct) = pct_str.as_str().parse::<f64>() {
                                let _ = sender.send(&json!({
                                    "type": "progress-pct",
                                    "percent": pct
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
            let _ = sender.send(&json!({
                "type": "done",
                "folder": out_dir.to_string_lossy()
            }));
        }
        Ok(s) => {
            let _ = sender.send(&json!({
                "type": "error",
                "message": format!("yt-dlp terminó con error (código {:?}). Revisa los mensajes anteriores.", s.code())
            }));
        }
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "error",
                "message": format!("Error esperando proceso yt-dlp: {}", e)
            }));
        }
    }
}
