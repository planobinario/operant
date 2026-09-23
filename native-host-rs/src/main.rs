mod protocol;
mod installer;
mod tools;
mod ytdl;
mod ffmpeg_ops;
mod recorder;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};

use protocol::{read_message, MessageSender};
use recorder::RecorderManager;
use tools::tools_status;

fn is_stdin_pipe() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
        use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE};
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            if handle == std::ptr::null_mut() || handle == -1isize as _ {
                return false;
            }
            GetFileType(handle) == FILE_TYPE_PIPE
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Operant Native Messaging Host v0.4.0 (Rust)");
        println!();
        println!("Uso:");
        println!("  operant-host [opciones]");
        println!();
        println!("Opciones:");
        println!("  --install      Registra el host en Chrome, Edge y Firefox (silencioso)");
        println!("  --uninstall    Elimina el registro del host del sistema");
        println!("  --help, -h     Muestra esta ayuda");
        println!();
        println!("Si se ejecuta mediante doble clic, se auto-instala automáticamente.");
        return;
    }

    if args.iter().any(|a| a == "--uninstall") {
        if let Err(e) = installer::uninstall(false) {
            eprintln!("[ERROR] {}", e);
            std::process::exit(1);
        }
        return;
    }

    if args.iter().any(|a| a == "--install") {
        if let Err(e) = installer::install(false) {
            eprintln!("[ERROR] {}", e);
            std::process::exit(1);
        }
        return;
    }

    // Si el usuario hace doble clic sobre el .exe o lo ejecuta directamente en una consola sin pipe
    if !is_stdin_pipe() && args.len() == 1 {
        if let Err(e) = installer::install(true) {
            installer::show_message_box("Operant Companion - Error", &e, true);
            std::process::exit(1);
        }
        return;
    }

    // Modo Native Messaging (lanzado por el navegador)
    let sender = MessageSender::new();
    let recorder = RecorderManager::new();
    let installing: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    loop {
        let msg = match read_message::<Value>() {
            Ok(Some(m)) => m,
            Ok(None) => break, // Fin de conexión del navegador
            Err(e) => {
                let _ = sender.send(&json!({
                    "type": "error",
                    "message": format!("Error leyendo mensaje: {}", e)
                }));
                break;
            }
        };

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match msg_type {
            "ping" => {
                let _ = sender.send(&json!({
                    "type": "pong",
                    "tools": tools_status()
                }));
            }
            "check-updates" => {
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    let _ = tools::fetch_ytdlp_latest();
                    let _ = s_clone.send(&json!({
                        "type": "tools-status",
                        "tools": tools_status()
                    }));
                });
            }
            "install" | "update" => {
                let tool = msg.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if tool != "yt-dlp" && tool != "ffmpeg" {
                    let _ = sender.send(&json!({
                        "type": "tool-error",
                        "tool": tool,
                        "message": "Herramienta desconocida"
                    }));
                    continue;
                }

                {
                    let mut lock = installing.lock().unwrap();
                    if lock.contains(&tool) {
                        let _ = sender.send(&json!({
                            "type": "tool-error",
                            "tool": tool,
                            "message": "Ya hay una instalación en curso."
                        }));
                        continue;
                    }
                    lock.insert(tool.clone());
                }

                let s_clone = sender.clone();
                let inst_clone = installing.clone();
                std::thread::spawn(move || {
                    if tool == "yt-dlp" {
                        tools::install_ytdlp(s_clone);
                    } else {
                        tools::install_ffmpeg(s_clone);
                    }
                    let mut lock = inst_clone.lock().unwrap();
                    lock.remove(&tool);
                });
            }
            "uninstall" => {
                let tool = msg.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    let res = tools::uninstall_tool(&tool);
                    let _ = s_clone.send(&json!({
                        "type": "tool-uninstalled",
                        "tool": tool,
                        "ok": res.is_ok(),
                        "error": res.err(),
                        "tools": tools::tools_status()
                    }));
                });
            }
            "ytdl" => {
                let url = msg.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if url.is_empty() {
                    let _ = sender.send(&json!({ "type": "error", "message": "URL vacía." }));
                    continue;
                }
                let fmt = msg.get("format").and_then(|v| v.as_str()).map(|s| s.to_string());
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    ytdl::run_download(&url, fmt, s_clone);
                });
            }
            "ytdl-list-formats" => {
                let url = msg.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if url.is_empty() {
                    let _ = sender.send(&json!({ "type": "formats-error", "message": "URL vacía." }));
                    continue;
                }
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    ytdl::list_formats(&url, s_clone);
                });
            }
            "ffmpeg-op" => {
                let url = msg.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if url.is_empty() {
                    let _ = sender.send(&json!({ "type": "ffmpeg-error", "message": "URL vacía." }));
                    continue;
                }
                let op = msg.get("op").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let options = msg.get("options").cloned().unwrap_or(json!({}));
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    ffmpeg_ops::run_ffmpeg_op(&url, &op, options, s_clone);
                });
            }
            "rec-begin" => {
                recorder.begin(&sender);
            }
            "rec-append" => {
                let sess = msg.get("session").and_then(|v| v.as_str()).unwrap_or("");
                let track = msg.get("track").and_then(|v| v.as_str()).unwrap_or("video");
                let data = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
                recorder.append(sess, track, data, &sender);
            }
            "rec-end" => {
                let sess = msg.get("session").and_then(|v| v.as_str()).unwrap_or("");
                let filename = msg.get("filename").and_then(|v| v.as_str());
                recorder.end(sess, filename, sender.clone());
            }
            "rec-cancel" => {
                let sess = msg.get("session").and_then(|v| v.as_str()).unwrap_or("");
                recorder.cancel(sess, &sender);
            }
            _ => {
                let _ = sender.send(&json!({
                    "type": "error",
                    "message": format!("Tipo de mensaje desconocido: {}", msg_type)
                }));
            }
        }
    }
}
