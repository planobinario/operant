use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

use crate::proc::{describe_failure, run_capture_streaming};
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

/// Lee una lista de segmentos del `options` que envía el service worker.
///
/// Acepta tanto un array de strings como un array de objetos `{url}` (que es lo
/// que produce el parser DASH cuando el segmento trae metadata). Filtra vacíos
/// y URLs no http(s), para que un valor corrupto no acabe como argumento de
/// ffmpeg.
pub fn segment_list(options: &Value, key: &str) -> Vec<String> {
    let arr = match options.get(key).and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let url = match item {
            Value::String(s) => s.clone(),
            Value::Object(_) => item
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string(),
            _ => String::new(),
        };
        let trimmed = url.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

/// Descarga una lista de segmentos fMP4 y los concatena en `dest`.
///
/// Cada segmento se baja a un fichero temporal y solo se anexa a `dest` cuando
/// la descarga ha terminado con éxito. Así un fallo a mitad no deja un archivo
/// "medio concatenado" que luego se valida como bueno: o está entero, o el
/// llamador recibe un error y el TempDir limpia todo al salir.
///
/// Los segmentos fMP4 de DASH son "trozos" del MISMO medio (init + medios), y
/// un MP4 se puede concatenar byte a byte porque sus cajas son autocontenidas en
/// tamaño. Devuelve el número de bytes escritos.
pub fn concat_segments(
    urls: &[String],
    dest: &Path,
    label: &str,
    progress_base: u32,
    progress_span: u32,
    sender: &MessageSender,
) -> Result<u64, String> {
    let parent = dest
        .parent()
        .ok_or_else(|| "ruta de trabajo inválida".to_string())?;
    let mut total_bytes: u64 = 0;
    let total = urls.len();

    for (index, url) in urls.iter().enumerate() {
        let part = parent.join(format!("{}_part_{}.m4s", label, index));
        let s = sender.clone();
        let base = progress_base;
        let span = progress_span;
        let n = index;
        let count = total;

        let result = download_file_with_progress(url, &part, move |p| {
            // Progreso repartido dentro del span de este track.
            let within = ((n as f64) + (p as f64 / 100.0)) / (count as f64);
            let pct = (base as f64 + span as f64 * within).min(99.0) as u32;
            let _ =
                s.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": pct }));
        });

        let size = match result {
            Ok(()) => fs::metadata(&part).map(|m| m.len()).unwrap_or(0),
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(format!(
                    "segmento {}/{} ({}): {}",
                    index + 1,
                    total,
                    label,
                    e
                ));
            }
        };

        if size == 0 {
            let _ = fs::remove_file(&part);
            return Err(format!(
                "segmento {}/{} ({}) descarga 0 bytes: la URL del segmento ha caducado o requiere cookies",
                index + 1,
                total,
                label
            ));
        }

        // El init segment va SIEMPRE el primero: el orden de la lista es el
        // orden del manifiesto y no se puede reordenar.
        let mut data = Vec::with_capacity(size as usize);
        File::open(&part)
            .and_then(|mut f| f.read_to_end(&mut data))
            .map_err(|e| format!("leyendo segmento {}: {}", index + 1, e))?;
        let _ = fs::remove_file(&part);

        append_bytes(dest, &data)?;
        total_bytes += data.len() as u64;
    }

    if total_bytes == 0 {
        return Err("no se descargó ningún byte".to_string());
    }
    Ok(total_bytes)
}

/// Añade bytes al final de un fichero, creándolo si no existe.
fn append_bytes(dest: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dest)
        .map_err(|e| format!("abriendo {:?}: {}", dest, e))?;
    file.write_all(data)
        .map_err(|e| format!("escribiendo en {:?}: {}", dest, e))?;
    file.flush()
        .map_err(|e| format!("finalizando {:?}: {}", dest, e))
}

pub fn probe_duration(ffmpeg_path: &Path, src: &str) -> Option<f64> {
    let probe_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let probe_path = ffmpeg_path.parent()?.join(probe_name);
    let probe_bin = if probe_path.is_file() {
        probe_path
    } else {
        crate::tools::find_in_path("ffprobe")?
    };

    let mut cmd = create_no_window_cmd(&probe_bin);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        src,
    ])
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
        let mut custom = Path::new(opt_fn)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if let Some(pos) = custom.rfind('.') {
            custom.truncate(pos);
        }
        if !custom.is_empty() {
            base_name = custom;
        }
    }

    let temp_dir = tempfile::Builder::new().prefix("operant-ffmpeg-").tempdir();

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
        let video_url = options
            .get("videoUrl")
            .and_then(|v| v.as_str())
            .unwrap_or(url);

        let src_v = workdir.path().join("video.mp4");
        let src_a = workdir.path().join("audio.mp4");

        // EL DEFECTO QUE ESTO ARREGLA
        // ----------------------------
        // El service worker envía `videoSegments` / `audioSegments` (init
        // segment + todos los media segments del .mpd) porque para DASH de
        // X/Reddit/Instagram un "track" no es un archivo sino una lista. Este
        // host leía únicamente `videoUrl` / `audioUrl`, que son UN SOLO
        // fragmento — y normalmente el init segment, de ~800 bytes. El
        // resultado era un mp4 de 1 KB con "éxito" confirmado. El host Python
        // que este código reemplazaba sí concatenaba los segmentos: era una
        // regresión funcional.
        let video_segments = segment_list(&options, "videoSegments");
        let audio_segments = segment_list(&options, "audioSegments");

        let _ =
            sender.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 0 }));

        let fetched_v = if !video_segments.is_empty() {
            concat_segments(&video_segments, &src_v, "video", 0, 45, &sender)
        } else {
            let s = sender.clone();
            download_file_with_progress(video_url, &src_v, move |p| {
                let _ = s.send(
                    &json!({ "type": "ffmpeg-progress", "phase": "download", "progress": p / 2 }),
                );
            })
            .map(|_| 1u64)
        };

        let fetched_a = match fetched_v {
            Ok(n) if n > 0 => {
                let s = sender.clone();
                if !audio_segments.is_empty() {
                    concat_segments(&audio_segments, &src_a, "audio", 45, 50, &sender)
                } else {
                    download_file_with_progress(audio_url, &src_a, move |p| {
                        let _ = s.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 50 + p / 2 }));
                    })
                    .map(|_| 1u64)
                }
            }
            _ => Err("no se pudo descargar el track de vídeo".to_string()),
        };

        if fetched_a.is_err() {
            if let Err(e) = fetched_a {
                let _ = sender.send(&json!({
                    "type": "ffmpeg-error",
                    "message": format!("Fallo descargando el audio de DASH: {}", e)
                }));
            }
            return;
        }

        // Verificación de integridad ANTES de invocar a ffmpeg: un init segment
        // concatenado sin muestras es indistinguible de un vídeo para ffmpeg,
        // que sin quejarse produciría un archivo de 1 KB y saldría con éxito.
        if !looks_like_real_media(&src_v) {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": "El track de vídeo de DASH parece un init segment vacío o contenido no válido (solo metadatos, sin muestras). Reproduce el vídeo en la página y vuelve a intentarlo.".to_string()
            }));
            return;
        }
        if !looks_like_real_media(&src_a) {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": "El track de audio de DASH no contiene muestras (init segment vacío o respuesta de error).".to_string()
            }));
            return;
        }

        let _ =
            sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));

        duration = probe_duration(&ffmpeg.path, &src_v.to_string_lossy());
        size_before = fs::metadata(&src_v).map(|m| m.len()).unwrap_or(0)
            + fs::metadata(&src_a).map(|m| m.len()).unwrap_or(0);

        // `-map` EXPLÍCITO. Con dos entradas, la selección automática de ffmpeg
        // elige "la mejor" de cada tipo entre AMBAS, así que una variante muxada
        // podía ganar e ignorar el audio separado. Ahora el mapping dice de
        // dónde sale cada pista, que es justo la razón de existir de esta op.
        cmd.args([
            "-i",
            &src_v.to_string_lossy(),
            "-i",
            &src_a.to_string_lossy(),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ]);
    } else if op == "hls-dash" {
        out_ext = "mp4";
        let _ =
            sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));
        duration = probe_duration(&ffmpeg.path, url);
        size_before = 0;
        cmd.args(["-i", url]);
        // Masters HLS con audio SEPARADO (X/Twitter, YouTube Live): la
        // variante es solo vídeo y el audio viaja en un playlist propio
        // (#EXT-X-MEDIA). Con audioUrl se muxean ambas entradas (-c copy,
        // sin recodificar); sin él, entrada única como siempre.
        let audio_url = options
            .get("audioUrl")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        if let Some(a) = audio_url {
            cmd.args(["-i", a]);
            // Igual que en dash-merge: con dos entradas la selección
            // automática puede quedarse con la pista equivocada.
            cmd.args(["-map", "0:v:0", "-map", "1:a:0"]);
        }
        cmd.args(["-c", "copy", "-movflags", "+faststart"]);
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
        let _ =
            sender.send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": 0 }));

        let s_clone = sender.clone();
        if let Err(e) = download_file_with_progress(url, &src_input, move |p| {
            let _ = s_clone
                .send(&json!({ "type": "ffmpeg-progress", "phase": "download", "progress": p }));
        }) {
            let _ = sender.send(&json!({ "type": "ffmpeg-error", "message": format!("Fallo descargando recurso: {}", e) }));
            return;
        }

        size_before = fs::metadata(&src_input).map(|m| m.len()).unwrap_or(0);
        let _ =
            sender.send(&json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 0 }));
        duration = probe_duration(&ffmpeg.path, &src_input.to_string_lossy());

        cmd.args(["-i", &src_input.to_string_lossy()]);

        match op {
            "extract-mp3" => {
                cmd.args(["-vn", "-c:a", "libmp3lame", "-b:a", "192k"]);
            }
            "remux-mp4" => {
                cmd.args(["-c", "copy", "-movflags", "+faststart"]);
            }
            "convert-webm" => {
                cmd.args([
                    "-c:v", "libvpx", "-crf", "30", "-b:v", "2M", "-c:a", "libopus",
                ]);
            }
            "compress" => {
                let crf = options.get("crf").and_then(|v| v.as_i64()).unwrap_or(28);
                cmd.args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    &crf.to_string(),
                    "-c:a",
                    "aac",
                ]);
            }
            "resize-50" => {
                cmd.args([
                    "-vf",
                    "scale=iw*0.5:ih*0.5",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-c:a",
                    "aac",
                ]);
            }
            "img-jpg" => {
                cmd.args(["-q:v", "2"]);
            }
            "img-webp" => {
                cmd.args(["-q:v", "75"]);
            }
            _ => {}
        }
    }

    let out_name = format!("{}_{}.{}", base_name, op, out_ext);
    let out_path = out_dir.join(&out_name);

    // ffmpeg escribe el PROGRESO por stdout (`-progress pipe:1`) y el
    // DIAGNÓSTICO por stderr. Ambos se drenan: stdout en este hilo, stderr en
    // uno dedicado (ver crate::proc). Antes stderr se pipeaba sin leer nunca y
    // el proceso se colgaba al superar el búfer del pipe, dejando la UI en
    // "Procesando…" para siempre y dos procesos zombis.
    cmd.args([
        "-progress",
        "pipe:1",
        "-nostats",
        &out_path.to_string_lossy(),
    ]);

    let progress_duration = duration;
    let (status, stderr_tail) = match run_capture_streaming(&mut cmd, |line| {
        if let Some(rest) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = rest.trim().parse::<f64>() {
                if let Some(dur) = progress_duration {
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
    }) {
        Ok(v) => v,
        Err(e) => {
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": format!("Error ejecutando ffmpeg: {}", e)
            }));
            return;
        }
    };

    if status.success() {
        let size_after = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        // Un ffmpeg que "termina bien" puede haber producido un archivo
        // inservible (0 bytes). No se entrega sin comprobarlo: la misma puerta
        // de integridad que usa el grabador (looks_like_real_media).
        if size_after == 0 {
            let _ = fs::remove_file(&out_path);
            let _ = sender.send(&json!({
                "type": "ffmpeg-error",
                "message": "ffmpeg terminó correctamente pero no produjo ningún archivo de salida.".to_string()
            }));
            return;
        }
        let _ = sender.send(&json!({
            "type": "ffmpeg-done",
            "output": out_path.to_string_lossy(),
            "name": out_name,
            "sizeBefore": size_before,
            "sizeAfter": size_after
        }));
    } else {
        let _ = sender.send(&json!({
            "type": "ffmpeg-error",
            "message": describe_failure("ffmpeg", status, &stderr_tail, 12)
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn segment_list_acepta_array_de_strings() {
        let options = json!({
            "videoSegments": [
                "https://cdn.e.com/init.mp4",
                "https://cdn.e.com/seg1.m4s",
                "https://cdn.e.com/seg2.m4s"
            ]
        });
        let list = segment_list(&options, "videoSegments");
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], "https://cdn.e.com/init.mp4");
        assert_eq!(list[2], "https://cdn.e.com/seg2.m4s");
    }

    #[test]
    fn segment_list_acepta_array_de_objetos() {
        // El parser DASH puede emitir objetos con metadata.
        let options = json!({
            "audioSegments": [
                { "url": "https://cdn.e.com/a-init.mp4", "duration": 0 },
                { "url": "https://cdn.e.com/a1.m4s" }
            ]
        });
        let list = segment_list(&options, "audioSegments");
        assert_eq!(
            list,
            vec!["https://cdn.e.com/a-init.mp4", "https://cdn.e.com/a1.m4s"]
        );
    }

    #[test]
    fn segment_list_descarta_valores_no_descargables() {
        // Un valor corrupto o malicioso no debe acabar como argumento de ffmpeg
        // ni como petición HTTP del host.
        let options = json!({
            "videoSegments": [
                "https://cdn.e.com/ok.m4s",
                "",
                "   ",
                "file:///etc/passwd",
                "javascript:alert(1)",
                "data:text/html,<script>",
                42,
                null
            ]
        });
        let list = segment_list(&options, "videoSegments");
        assert_eq!(list, vec!["https://cdn.e.com/ok.m4s"]);
    }

    #[test]
    fn segment_list_vacia_si_no_existe_la_clave() {
        let options = json!({ "otraCosa": ["https://x/y"] });
        assert!(segment_list(&options, "videoSegments").is_empty());
        assert!(segment_list(&json!({}), "videoSegments").is_empty());
    }

    #[test]
    fn segment_list_no_panea_si_el_valor_no_es_array() {
        let options = json!({ "videoSegments": "https://cdn.e.com/un.mp4" });
        assert!(segment_list(&options, "videoSegments").is_empty());
    }

    #[test]
    fn looks_like_real_media_rechaza_manifiestos_y_texto() {
        let dir = tempfile::Builder::new()
            .prefix("operant-test-")
            .tempdir()
            .unwrap();
        let m3u8 = dir.path().join("a.m3u8");
        fs::write(&m3u8, b"#EXTM3U\n#EXTINF:4,\nseg0.ts\n").unwrap();
        assert!(!looks_like_real_media(&m3u8), "un .m3u8 no es un medio");

        let txt = dir.path().join("b.txt");
        fs::write(&txt, b"<!DOCTYPE html><html>error 403</html>").unwrap();
        assert!(
            !looks_like_real_media(&txt),
            "una página de error no es un medio"
        );
    }

    #[test]
    fn looks_like_real_media_rechaza_init_segment() {
        // El caso real del bug: un init segment de fMP4 (moov/trak sin mdat)
        // pesa poco y NO contiene muestras.
        let dir = tempfile::Builder::new()
            .prefix("operant-test-")
            .tempdir()
            .unwrap();
        let init = dir.path().join("init.mp4");
        // ftyp + moov, sin mdat, rellenado hasta pasar 1 KB.
        let mut data = Vec::new();
        data.extend_from_slice(&[0, 0, 0, 0x18]);
        data.extend_from_slice(b"ftypisom");
        data.extend_from_slice(&[0, 0, 0, 0x08]);
        data.extend_from_slice(b"free");
        data.resize(2048, 0);
        fs::write(&init, &data).unwrap();
        assert!(
            !looks_like_real_media(&init),
            "un init segment no debe pasar como medio"
        );
    }

    #[test]
    fn looks_like_real_media_acepta_un_mp4_con_mdat() {
        let dir = tempfile::Builder::new()
            .prefix("operant-test-")
            .tempdir()
            .unwrap();
        let real = dir.path().join("real.mp4");
        let mut data = vec![0u8; 2048];
        data[0..4].copy_from_slice(&[0, 0, 0, 0x18]);
        data[4..8].copy_from_slice(b"ftyp");
        data[64..68].copy_from_slice(b"mdat");
        fs::write(&real, &data).unwrap();
        assert!(looks_like_real_media(&real));
    }
}
