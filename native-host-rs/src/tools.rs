use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use regex::Regex;
use serde_json::json;

use crate::protocol::MessageSender;

pub const YTDLP_DL_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
pub const GYAN_FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
pub const GH_UA: &str = "operant/0.4.0";

pub fn bin_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OPERANT_BIN") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
            format!("{}\\AppData\\Local", home)
        });
        PathBuf::from(base).join("Operant").join("bin")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".local").join("share").join("Operant").join("bin")
    }
}

pub fn output_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
        PathBuf::from(home).join("Downloads").join("Operant")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join("Downloads").join("Operant")
    }
}

pub fn create_no_window_cmd(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

#[derive(Debug, Clone)]
pub struct DetectedTool {
    pub path: PathBuf,
    pub source: &'static str,
    pub raw: String,
}

pub fn run_capture(exe: &Path, arg: &str) -> Option<String> {
    let mut cmd = create_no_window_cmd(exe);
    cmd.arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr).trim().to_string();
    if combined.is_empty() { None } else { Some(combined) }
}

pub fn find_in_path(tool: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    let exts: Vec<&str> = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };

    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(sep) {
        let dir_path = Path::new(dir);
        for ext in &exts {
            let candidate = dir_path.join(format!("{}{}", tool, ext));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn detect(tool: &str) -> Option<DetectedTool> {
    let version_arg = if tool == "yt-dlp" { "--version" } else { "-version" };
    let bd = bin_dir();

    let exts: Vec<&str> = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };

    for ext in &exts {
        let cand = bd.join(format!("{}{}", tool, ext));
        if cand.is_file() {
            if let Some(raw) = run_capture(&cand, version_arg) {
                return Some(DetectedTool {
                    path: cand,
                    source: "app",
                    raw,
                });
            }
        }
    }

    if let Some(sys_path) = find_in_path(tool) {
        if let Some(raw) = run_capture(&sys_path, version_arg) {
            return Some(DetectedTool {
                path: sys_path,
                source: "system",
                raw,
            });
        }
    }

    None
}

pub fn parse_ytdlp_version(raw: &str) -> Option<String> {
    let re = Regex::new(r"(\d{4}\.\d{2}\.\d{2})").ok()?;
    re.captures(raw).and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

pub fn parse_ffmpeg_version(raw: &str) -> Option<String> {
    raw.lines().next().map(|line| {
        let trimmed = line.trim();
        if trimmed.len() > 80 {
            trimmed[..80].to_string()
        } else {
            trimmed.to_string()
        }
    })
}

pub fn parse_version(tool: &str, raw: &str) -> Option<String> {
    if tool == "yt-dlp" {
        parse_ytdlp_version(raw)
    } else {
        parse_ffmpeg_version(raw)
    }
}

pub fn fetch_ytdlp_latest() -> Option<String> {
    let agent = ureq::builder()
        .redirects(0)
        .user_agent(GH_UA)
        .build();

    let asset = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let url = format!("{}{}", YTDLP_DL_URL, asset);

    let resp = agent.head(&url).call();
    let location = match resp {
        Ok(r) => r.header("Location").map(|s| s.to_string()),
        Err(ureq::Error::Status(code, r)) if (300..=399).contains(&code) => {
            r.header("Location").map(|s| s.to_string())
        }
        _ => None,
    }?;

    let re = Regex::new(r"/releases/download/v?(\d{4}\.\d{2}\.\d{2})/").ok()?;
    re.captures(&location).and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

pub fn tool_status(tool: &str) -> serde_json::Value {
    let det = match detect(tool) {
        Some(d) => d,
        None => {
            return json!({
                "tool": tool,
                "status": "not-installed",
                "path": null,
                "version": null,
                "source": null,
                "updateAvailable": false,
                "latestVersion": null,
                "updateCheckError": null
            });
        }
    };

    let version = parse_version(tool, &det.raw);
    let mut latest = None;
    let mut update_available = false;

    if tool == "yt-dlp" {
        if let Some(l) = fetch_ytdlp_latest() {
            if let Some(ref v) = version {
                update_available = l > *v;
            }
            latest = Some(l);
        }
    }

    json!({
        "tool": tool,
        "status": "installed",
        "path": det.path.to_string_lossy(),
        "version": version,
        "source": det.source,
        "updateAvailable": update_available,
        "latestVersion": latest,
        "updateCheckError": null
    })
}

pub fn tools_status() -> serde_json::Value {
    let yt = tool_status("yt-dlp");
    let ff = tool_status("ffmpeg");
    json!({
        "ytDlp": yt,
        "yt-dlp": yt,
        "ffmpeg": ff
    })
}

pub fn uninstall_tool(tool: &str) -> Result<(), String> {
    let bd = bin_dir();
    let exts: Vec<&str> = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };

    if tool == "yt-dlp" {
        for ext in &exts {
            let p = bd.join(format!("yt-dlp{}", ext));
            if p.is_file() {
                let _ = fs::remove_file(&p);
            }
        }
        return Ok(());
    }

    if tool == "ffmpeg" {
        for sub in &["ffmpeg", "ffprobe", "ffplay"] {
            for ext in &exts {
                let p = bd.join(format!("{}{}", sub, ext));
                if p.is_file() {
                    let _ = fs::remove_file(&p);
                }
            }
        }
        return Ok(());
    }

    Err(format!("Herramienta no soportada para desinstalación: {}", tool))
}

pub fn download_file_with_progress<F>(url: &str, dest: &Path, mut on_progress: F) -> Result<(), String>
where
    F: FnMut(u32),
{
    let agent = ureq::builder()
        .user_agent(GH_UA)
        .timeout(std::time::Duration::from_secs(120))
        .build();

    let resp = agent.get(url).call().map_err(|e| format!("HTTP GET error: {}", e))?;
    let total: u64 = resp.header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut file = File::create(dest).map_err(|e| format!("Error creando archivo {:?}: {}", dest, e))?;

    let mut buffer = [0u8; 65536];
    let mut got: u64 = 0;
    let mut last_pct = 0;

    loop {
        let n = reader.read(&mut buffer).map_err(|e| format!("Error leyendo stream: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n]).map_err(|e| format!("Error escribiendo en archivo: {}", e))?;
        got += n as u64;

        if total > 0 {
            let pct = ((got * 100) / total).min(99) as u32;
            if pct != last_pct {
                last_pct = pct;
                on_progress(pct);
            }
        }
    }

    file.flush().map_err(|e| format!("Error finalizando archivo: {}", e))?;
    Ok(())
}

pub fn verify_and_install(tool: &str, tmp_exe: &Path, final_exe: &Path, sender: &MessageSender) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(tmp_exe).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(perms.mode() | 0o111);
        let _ = fs::set_permissions(tmp_exe, perms);
    }

    let version_arg = if tool == "yt-dlp" { "--version" } else { "-version" };
    let raw = run_capture(tmp_exe, version_arg)
        .ok_or_else(|| "El binario descargado no responde (descarga corrupta o incompatible)".to_string())?;

    let version = parse_version(tool, &raw)
        .ok_or_else(|| "No se pudo verificar la versión del binario descargado".to_string())?;

    if let Some(parent) = final_exe.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if final_exe.exists() {
        let _ = fs::remove_file(final_exe);
    }

    fs::rename(tmp_exe, final_exe)
        .map_err(|e| format!("Error en reemplazo atómico a {:?}: {}", final_exe, e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(final_exe).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(perms.mode() | 0o111);
        let _ = fs::set_permissions(final_exe, perms);
    }

    let _ = sender.send(&json!({
        "type": "tool-done",
        "tool": tool,
        "version": version,
        "path": final_exe.to_string_lossy()
    }));

    Ok(())
}

pub fn install_ytdlp(sender: MessageSender) {
    let tool = "yt-dlp";
    let bd = bin_dir();
    let _ = fs::create_dir_all(&bd);

    let asset = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let tmp = bd.join(format!("{}.new.exe", tool));
    let final_exe = bd.join(asset);

    let _ = sender.send(&json!({ "type": "tool-progress", "tool": tool, "phase": "download", "progress": 0 }));

    let s_clone = sender.clone();
    let download_res = download_file_with_progress(&format!("{}{}", YTDLP_DL_URL, asset), &tmp, move |p| {
        let _ = s_clone.send(&json!({ "type": "tool-progress", "tool": tool, "phase": "download", "progress": p }));
    });

    if let Err(e) = download_res {
        let _ = fs::remove_file(&tmp);
        let _ = sender.send(&json!({ "type": "tool-error", "tool": tool, "message": format!("Fallo al descargar yt-dlp: {}", e) }));
        return;
    }

    let _ = sender.send(&json!({ "type": "tool-progress", "tool": tool, "phase": "verify", "progress": 99 }));
    if let Err(e) = verify_and_install(tool, &tmp, &final_exe, &sender) {
        let _ = fs::remove_file(&tmp);
        let _ = sender.send(&json!({ "type": "tool-error", "tool": tool, "message": e }));
    }
}

pub fn install_ffmpeg(sender: MessageSender) {
    let bd = bin_dir();
    let _ = fs::create_dir_all(&bd);

    let _ = sender.send(&json!({ "type": "tool-progress", "tool": "ffmpeg", "phase": "download", "progress": 0 }));

    let zip_path = bd.join("ffmpeg.download.zip");
    let s_clone = sender.clone();

    let download_res = download_file_with_progress(GYAN_FFMPEG_URL, &zip_path, move |p| {
        let _ = s_clone.send(&json!({ "type": "tool-progress", "tool": "ffmpeg", "phase": "download", "progress": p }));
    });

    if let Err(e) = download_res {
        let _ = fs::remove_file(&zip_path);
        let _ = sender.send(&json!({ "type": "tool-error", "tool": "ffmpeg", "message": format!("Fallo descargando ffmpeg: {}", e) }));
        return;
    }

    let _ = sender.send(&json!({ "type": "tool-progress", "tool": "ffmpeg", "phase": "extract", "progress": 95 }));

    let file = match File::open(&zip_path) {
        Ok(f) => f,
        Err(e) => {
            let _ = fs::remove_file(&zip_path);
            let _ = sender.send(&json!({ "type": "tool-error", "tool": "ffmpeg", "message": format!("Error abriendo zip de ffmpeg: {}", e) }));
            return;
        }
    };

    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            let _ = fs::remove_file(&zip_path);
            let _ = sender.send(&json!({ "type": "tool-error", "tool": "ffmpeg", "message": format!("Error leyendo archivo zip: {}", e) }));
            return;
        }
    };

    let mut pairs = Vec::new();
    for i in 0..archive.len() {
        if let Ok(mut item) = archive.by_index(i) {
            let name = match item.enclosed_name() {
                Some(p) => p.file_name().unwrap_or_default().to_string_lossy().to_string(),
                None => continue,
            };

            if name == "ffmpeg.exe" || name == "ffprobe.exe" {
                let tool_name = if name == "ffmpeg.exe" { "ffmpeg" } else { "ffprobe" };
                let tmp_path = bd.join(format!("{}.new.exe", tool_name));
                let final_path = bd.join(&name);

                if let Ok(mut out) = File::create(&tmp_path) {
                    if io::copy(&mut item, &mut out).is_ok() {
                        pairs.push((tool_name, tmp_path, final_path));
                    }
                }
            }
        }
    }

    let _ = fs::remove_file(&zip_path);

    if pairs.is_empty() {
        let _ = sender.send(&json!({ "type": "tool-error", "tool": "ffmpeg", "message": "No se encontraron ffmpeg.exe ni ffprobe.exe dentro del paquete." }));
        return;
    }

    let _ = sender.send(&json!({ "type": "tool-progress", "tool": "ffmpeg", "phase": "verify", "progress": 99 }));
    for (tool_name, tmp_path, final_path) in pairs {
        if let Err(e) = verify_and_install(tool_name, &tmp_path, &final_path, &sender) {
            let _ = fs::remove_file(&tmp_path);
            let _ = sender.send(&json!({ "type": "tool-error", "tool": tool_name, "message": e }));
        }
    }
}
