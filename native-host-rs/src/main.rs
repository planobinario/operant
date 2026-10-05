mod ffmpeg_ops;
mod installer;
mod protocol;
mod recorder;
mod tools;
mod ytdl;
// Ejecución de subprocesos con drenaje de ambos pipes (evita el deadlock de
// 64 KB en ffmpeg/yt-dlp) y con tail de stderr para diagnóstico.
mod proc;

use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use protocol::{read_message, Incoming, MessageSender, PROTOCOLS, PROTOCOL_V2};
use recorder::RecorderManager;
use tools::tools_status;

fn is_stdin_pipe() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE};
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            if handle.is_null() || handle == -1isize as _ {
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
        println!("Operant Native Messaging Host v0.5.0 (Rust)");
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
    let base_sender = MessageSender::new();
    let recorder = RecorderManager::new();
    let installing: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    loop {
        let raw = match read_message::<Value>() {
            Ok(Some(m)) => m,
            Ok(None) => break, // Fin de conexión del navegador
            Err(e) => {
                // Todavía no hay petición que contextualizar, así que se usa el
                // sender base y el mensaje sale en v1 plano. Un cliente v2 lo
                // entiende igual: su envoltorio sabe desenvolver un objeto plano.
                let _ = base_sender.send(&json!({
                    "type": "error",
                    "message": format!("Error leyendo mensaje: {}", e)
                }));
                break;
            }
        };

        // Normalización y contexto de respuesta. Todo lo que se envía desde este
        // hilo, y desde los hilos que lanza, sale en la versión que pidió el
        // cliente y con su `id` de correlación, sin tocar ytdl, ffmpeg_ops,
        // recorder ni tools.
        let incoming = Incoming::parse(&raw);
        let sender = base_sender.for_request(&incoming);
        let msg_type = incoming.kind.as_str();
        match msg_type {
            "ping" => {
                let _ = sender.send(&json!({
                    "type": "pong",
                    "tools": tools_status(),
                    // HANDSHAKE ADITIVO. Un cliente v1 ve un campo que no conoce y
                    // lo ignora; uno v2 lee las capacidades y decide si habla v2.
                    // Por eso el ping se puede hacer siempre en v1 plano: es la
                    // unica peticion que no necesita envelopedarse para detectar
                    // si el host la soporta.
                    "protocols": PROTOCOLS,
                    "protocol": PROTOCOL_V2,
                    "host": env!("CARGO_PKG_VERSION"),
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
                let tool = incoming.arg_string("tool");
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
                let tool = incoming.arg_string("tool");
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
                let url = incoming.arg_string("url");
                if url.is_empty() {
                    let _ = sender.send(&json!({ "type": "error", "message": "URL vacía." }));
                    continue;
                }
                let fmt = incoming.arg("format").map(|s| s.to_string());
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    ytdl::run_download(&url, fmt, s_clone);
                });
            }
            "ytdl-list-formats" => {
                let url = incoming.arg_string("url");
                if url.is_empty() {
                    let _ =
                        sender.send(&json!({ "type": "formats-error", "message": "URL vacía." }));
                    continue;
                }
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    ytdl::list_formats(&url, s_clone);
                });
            }
            "ffmpeg-op" => {
                let url = incoming.arg_string("url");
                if url.is_empty() {
                    let _ =
                        sender.send(&json!({ "type": "ffmpeg-error", "message": "URL vacía." }));
                    continue;
                }
                let op = incoming.arg_string("op");
                let options = incoming.arg_value("options");
                let s_clone = sender.clone();
                std::thread::spawn(move || {
                    ffmpeg_ops::run_ffmpeg_op(&url, &op, options, s_clone);
                });
            }
            "rec-begin" => {
                recorder.begin(&sender);
            }
            "rec-append" => {
                // El recorder sigue hablando con &str: el envelope se resuelve
                // en el borde (main.rs) y los módulos de dominio no necesitan
                // saber que existe una v2. Acoplarlo al protocolo haría que
                // cada firma tuviera que cambiar con cada versión.
                let sess = incoming.arg_string("session");
                let track = incoming.arg("track").unwrap_or("video");
                let data = incoming.arg("data").unwrap_or("");
                recorder.append(&sess, track, data, &sender);
            }
            "rec-end" => {
                let sess = incoming.arg_string("session");
                let filename = incoming.arg("filename");
                recorder.end(&sess, filename, sender.clone());
            }
            "rec-cancel" => {
                let sess = incoming.arg_string("session");
                recorder.cancel(&sess, &sender);
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
