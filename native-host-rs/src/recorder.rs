use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use base64::prelude::*;
use regex::Regex;
use serde_json::json;

use crate::ffmpeg_ops::looks_like_real_media;
use crate::protocol::MessageSender;
use crate::tools::{create_no_window_cmd, detect, output_dir};

pub struct RecSession {
    pub dir: PathBuf,
    pub video_path: PathBuf,
    pub audio_path: PathBuf,
}

#[derive(Clone)]
pub struct RecorderManager {
    sessions: Arc<Mutex<HashMap<String, RecSession>>>,
}

impl RecorderManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn begin(&self, sender: &MessageSender) {
        let rand_val = fastrand::u64(..);
        let session_id = format!("{:012x}", rand_val);

        let temp_dir = match tempfile::Builder::new().prefix("operant-rec-").tempdir() {
            Ok(td) => {
                let p = td.path().to_path_buf();
                std::mem::forget(td);
                p
            }
            Err(e) => {
                let _ = sender.send(&json!({
                    "type": "rec-error",
                    "session": session_id,
                    "message": format!("Error creando carpeta temporal: {}", e)
                }));
                return;
            }
        };

        let video_path = temp_dir.join("video.bin");
        let audio_path = temp_dir.join("audio.bin");
        let _ = fs::File::create(&video_path);
        let _ = fs::File::create(&audio_path);

        let mut map = self.sessions.lock().unwrap();
        map.insert(session_id.clone(), RecSession {
            dir: temp_dir,
            video_path,
            audio_path,
        });

        let _ = sender.send(&json!({
            "type": "rec-beginned",
            "session": session_id
        }));
    }

    pub fn append(&self, session_id: &str, track: &str, data: &str, sender: &MessageSender) {
        let map = self.sessions.lock().unwrap();
        let sess = match map.get(session_id) {
            Some(s) => s,
            None => {
                let _ = sender.send(&json!({
                    "type": "rec-error",
                    "session": session_id,
                    "message": "Sesión de grabación inválida."
                }));
                return;
            }
        };

        let target_path = if track == "audio" {
            &sess.audio_path
        } else {
            &sess.video_path
        };

        let raw = match BASE64_STANDARD.decode(data) {
            Ok(bytes) => bytes,
            Err(e) => {
                let _ = sender.send(&json!({
                    "type": "rec-error",
                    "session": session_id,
                    "message": format!("Error decodificando base64: {}", e)
                }));
                return;
            }
        };

        let mut file = match OpenOptions::new().create(true).append(true).open(target_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = sender.send(&json!({
                    "type": "rec-error",
                    "session": session_id,
                    "message": format!("Error abriendo archivo de track: {}", e)
                }));
                return;
            }
        };

        if let Err(e) = file.write_all(&raw) {
            let _ = sender.send(&json!({
                "type": "rec-error",
                "session": session_id,
                "message": format!("Error escribiendo chunk: {}", e)
            }));
            return;
        }

        let _ = sender.send(&json!({
            "type": "rec-appended",
            "session": session_id,
            "bytes": raw.len()
        }));
    }

    pub fn end(&self, session_id: &str, filename: Option<&str>, sender: MessageSender) {
        let sess = {
            let mut map = self.sessions.lock().unwrap();
            map.remove(session_id)
        };

        let sess = match sess {
            Some(s) => s,
            None => {
                let _ = sender.send(&json!({
                    "type": "rec-error",
                    "session": session_id,
                    "message": "Sesión de grabación inválida o ya finalizada."
                }));
                return;
            }
        };

        let fname = filename.unwrap_or("grabacion").to_string();
        std::thread::spawn(move || {
            finish_recording(sess, &fname, sender);
        });
    }

    pub fn cancel(&self, session_id: &str, sender: &MessageSender) {
        let sess = {
            let mut map = self.sessions.lock().unwrap();
            map.remove(session_id)
        };

        if let Some(s) = sess {
            let _ = fs::remove_dir_all(&s.dir);
        }

        let _ = sender.send(&json!({
            "type": "rec-cancelled",
            "session": session_id
        }));
    }
}

fn finish_recording(sess: RecSession, filename: &str, sender: MessageSender) {
    let _cleanup = defer_cleanup(&sess.dir);

    let ffmpeg = match detect("ffmpeg") {
        Some(d) => d,
        None => {
            let _ = sender.send(&json!({
                "type": "rec-error",
                "message": "ffmpeg no está instalado. Abre el panel -> Herramientas -> Instalar."
            }));
            return;
        }
    };

    let out_dir = output_dir();
    let _ = fs::create_dir_all(&out_dir);

    let invalid_chars = Regex::new(r#"[<>:"/\\|?*\x00-\x1f]+"#).unwrap();
    let mut base = invalid_chars.replace_all(filename, "_").trim().to_string();
    if let Some(pos) = base.rfind('.') {
        base.truncate(pos);
    }
    if base.is_empty() {
        base = "grabacion".to_string();
    }

    let mut out_path = out_dir.join(format!("{}.mp4", base));
    let mut n = 1;
    while out_path.exists() {
        out_path = out_dir.join(format!("{} ({}).mp4", base, n));
        n += 1;
    }

    let v_size = fs::metadata(&sess.video_path).map(|m| m.len()).unwrap_or(0);
    let a_size = fs::metadata(&sess.audio_path).map(|m| m.len()).unwrap_or(0);

    if v_size <= 1024 && a_size <= 1024 {
        let _ = sender.send(&json!({
            "type": "rec-error",
            "message": "La grabación no contiene suficientes datos multimedia."
        }));
        return;
    }

    let _ = sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));

    let mut cmd = create_no_window_cmd(&ffmpeg.path);
    cmd.arg("-y");

    if v_size > 1024 {
        cmd.args(["-i", &sess.video_path.to_string_lossy()]);
    }
    if a_size > 1024 {
        cmd.args(["-i", &sess.audio_path.to_string_lossy()]);
    }

    cmd.args(["-c", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", &out_path.to_string_lossy()]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "rec-error",
                "message": format!("Error ejecutando ffmpeg para finalizar grabación: {}", e)
            }));
            return;
        }
    };

    if !output.status.success() || !looks_like_real_media(&out_path) {
        let err_tail = String::from_utf8_lossy(&output.stderr);
        let trimmed_err = if err_tail.len() > 400 {
            &err_tail[err_tail.len() - 400..]
        } else {
            &err_tail
        };
        let _ = sender.send(&json!({
            "type": "rec-error",
            "message": format!("ffmpeg no pudo ensamblar la grabación: {}", trimmed_err)
        }));
        return;
    }

    let size_after = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let _ = sender.send(&json!({
        "type": "ffmpeg-done",
        "output": out_path.to_string_lossy(),
        "name": out_path.file_name().unwrap_or_default().to_string_lossy(),
        "sizeAfter": size_after
    }));
}

struct CleanupGuard<'a>(&'a Path);
impl<'a> Drop for CleanupGuard<'a> {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0);
    }
}
fn defer_cleanup(p: &Path) -> CleanupGuard<'_> {
    CleanupGuard(p)
}
