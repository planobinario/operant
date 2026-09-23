use std::fs;
use std::path::PathBuf;

pub const HOST_NAME: &str = "com.operant.native_host";
pub const EXTENSION_ID: &str = "apolplekoldkaignccbfcnejmoochdhf";
pub const GECKO_ID: &str = "operant@operant.dev";

pub fn get_manifest_path() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
                PathBuf::from(home).join("AppData").join("Local")
            });
        base.join("Operant").join("com.operant.native_host.json")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".config").join("operant").join("com.operant.native_host.json")
    }
}

pub fn install(interactive: bool) -> Result<(), String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("No se pudo obtener la ruta del ejecutable: {}", e))?;
    let manifest_path = get_manifest_path();

    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Error creando carpeta del manifest: {}", e))?;
    }

    let manifest_content = serde_json::json!({
        "name": HOST_NAME,
        "description": "Operant Native Host (yt-dlp/ffmpeg engine)",
        "path": exe_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [
            format!("chrome-extension://{}/", EXTENSION_ID)
        ],
        "allowed_extensions": [
            GECKO_ID
        ]
    });

    let json_str = serde_json::to_string_pretty(&manifest_content)
        .map_err(|e| format!("Error generando JSON del manifest: {}", e))?;

    fs::write(&manifest_path, json_str)
        .map_err(|e| format!("Error escribiendo archivo manifest en {:?}: {}", manifest_path, e))?;

    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let targets = [
            format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", HOST_NAME),
            format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", HOST_NAME),
            format!(r"Software\Mozilla\NativeMessagingHosts\{}", HOST_NAME),
        ];

        let manifest_str = manifest_path.to_string_lossy().to_string();

        for subkey_path in &targets {
            let (key, _) = hkcu.create_subkey(subkey_path)
                .map_err(|e| format!("Error creando clave de registro {}: {}", subkey_path, e))?;
            key.set_value("", &manifest_str)
                .map_err(|e| format!("Error escribiendo valor en registro {}: {}", subkey_path, e))?;
        }
    }

    println!("[OK] Operant Host instalado con éxito.");
    println!("     Ejecutable: {:?}", exe_path);
    println!("     Manifest:   {:?}", manifest_path);

    if interactive {
        show_message_box(
            "Operant Companion",
            &format!(
                "¡Operant Host se ha instalado y vinculado correctamente!\n\n\
                 Navegadores soportados: Chrome, Edge y Firefox.\n\
                 ID de Extensión: {}\n\n\
                 Ya puedes volver a tu navegador.",
                EXTENSION_ID
            ),
            false,
        );
    }

    Ok(())
}

pub fn uninstall(interactive: bool) -> Result<(), String> {
    let manifest_path = get_manifest_path();
    if manifest_path.exists() {
        let _ = fs::remove_file(&manifest_path);
    }

    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let targets = [
            format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", HOST_NAME),
            format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", HOST_NAME),
            format!(r"Software\Mozilla\NativeMessagingHosts\{}", HOST_NAME),
        ];

        for subkey_path in &targets {
            let _ = hkcu.delete_subkey(subkey_path);
        }
    }

    println!("[OK] Operant Host desinstalado con éxito.");

    if interactive {
        show_message_box(
            "Operant Companion",
            "Operant Host se ha desinstalado de tu sistema.",
            false,
        );
    }

    Ok(())
}

pub fn show_message_box(title: &str, message: &str, is_error: bool) {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK};

        let title_w: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
        let msg_w: Vec<u16> = OsStr::new(message).encode_wide().chain(Some(0)).collect();
        let flags = MB_OK | if is_error { MB_ICONERROR } else { MB_ICONINFORMATION };

        unsafe {
            MessageBoxW(std::ptr::null_mut(), msg_w.as_ptr(), title_w.as_ptr(), flags);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (title, message, is_error);
    }
}
