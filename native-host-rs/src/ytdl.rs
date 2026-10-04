use regex::Regex;
use serde_json::json;
use std::fs;

use crate::proc::{describe_failure, run_capture_both, run_capture_streaming};
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
    cmd.args(["-F", "--no-download", url]);

    // Antes se usaba `cmd.output()`, que además de descartar el stderr de
    // yt-dlp hacía el error inaccionable ("código 1" sin decir por qué). Ahora
    // se capturan ambas salidas y el mensaje incluye la causa real, que para
    // yt-dlp es donde vive el motivo ("Unsupported URL", "Private video",
    // "Sign in to confirm your age", traceback del extractor...).
    let (status, stdout_str, stderr_text) = match run_capture_both(&mut cmd) {
        Ok(v) => v,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "formats-error",
                "message": format!("Error al ejecutar yt-dlp: {}", e)
            }));
            return;
        }
    };

    if !status.success() {
        let _ = sender.send(&json!({
            "type": "formats-error",
            "message": describe_failure("yt-dlp -F", status, &stderr_text, 10)
        }));
        return;
    }

    let mut formats = Vec::new();
    let num_re = Regex::new(r"^\d+$").unwrap();

    for line in stdout_str.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('-')
            || trimmed.starts_with("ID")
            || trimmed.starts_with('─')
        {
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

    let audio_only = format_id
        .as_deref()
        .map(|f| f.to_lowercase().starts_with("bestaudio"))
        .unwrap_or(false);
    let fmt_arg = format_id
        .map(|f| format!("-f{}", f))
        .unwrap_or_else(|| "-f bestvideo*+bestaudio/best".to_string());

    let template = out_dir
        .join("%(title).120s [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string();

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

    // yt-dlp escribe el PROGRESO por stdout (con --newline) y la mayoría de
    // sus DIAGNÓSTICOS por stderr. Antes stderr se pipeaba y nunca se leía: al
    // superar el búfer del pipe, yt-dlp se bloqueaba escribiendo, stdout se
    // quedaba mudo y el host esperaba para siempre. La UI se quedaba en el
    // último porcentaje y el proceso quedaba zombi.
    //
    // Con crate::proc ambos pipes se drenan (stdout aquí, stderr en un hilo) y
    // el stderr se conserva como diagnóstico, que para yt-dlp es LA
    // información útil: sus mensajes de error son la causa raíz
    // ("Unsupported URL", "Sign in to confirm your age", ...).
    let pct_re = Regex::new(r"\]\s*([0-9.]+)%").unwrap();
    let run = run_capture_streaming(&mut cmd, |raw_line| {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            return;
        }
        let preview: String = if trimmed.chars().count() > 300 {
            trimmed.chars().take(300).collect()
        } else {
            trimmed.to_string()
        };
        let _ = sender.send(&json!({ "type": "progress", "line": preview }));

        if trimmed.contains("[download]") && trimmed.contains('%') {
            if let Some(caps) = pct_re.captures(trimmed) {
                if let Some(pct_str) = caps.get(1) {
                    if let Ok(pct) = pct_str.as_str().parse::<f64>() {
                        let _ = sender.send(&json!({ "type": "progress-pct", "percent": pct }));
                    }
                }
            }
        }
    });

    let (status, stderr_tail) = match run {
        Ok(v) => v,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "error",
                "message": format!("Error ejecutando yt-dlp: {}", e)
            }));
            return;
        }
    };

    if status.success() {
        let _ = sender.send(&json!({
            "type": "done",
            "folder": out_dir.to_string_lossy()
        }));
    } else {
        let _ = sender.send(&json!({
            "type": "error",
            "message": describe_failure("yt-dlp", status, &stderr_tail, 12)
        }));
    }
}
