// src/proc.rs — Ejecución de subprocesos sin deadlocks y con diagnóstico.
//
// EL DEFECTO QUE ESTE MÓDULO ARREGLA
// ----------------------------------
// ffmpeg_ops.rs y ytdl.rs configuraban el proceso con:
//
//     .stdout(Stdio::piped())
//     .stderr(Stdio::piped());   // <- pipeado pero NUNCA leído
//
// y luego solo leían `child.stdout`. Eso es un deadlock clásico de tubería: el
// búfer del pipe del stderr es de tamaño finito (64 KB en Linux/macOS, 4 KB en
// Windows). En cuanto el hijo escribe más de ese tamaño y nadie lo drena,
// `write()` se bloquea dentro del hijo; al dejar de escribir, stdout también se
// queda quieto; el reader de stdout se bloquea esperando más; y el proceso
// padre espera para siempre con `child.wait()`.
//
// ffmpeg con loglevel `info` escribe al menos una línea por segmento HLS: con
// 1.500 segmentos se supera el límite holgadamente. yt-dlp escribe la mayoría de
// sus diagnósticos (que además son LA información útil cuando algo falla) a
// stderr. El síntoma era: la UI se queda en "Procesando…" para siempre, sin
// `ffmpeg-done` ni `ffmpeg-error`, y dos procesos zombis.
//
// LA SOLUCIÓN
// -----------
// Drenar stderr en un hilo dedicado mientras el hilo principal lee stdout. Se
// conservan las dos propiedades que se necesitan:
//
//   · stdout queda limpio para el progreso (`-progress pipe:1` va por stdout),
//     así que las líneas `out_time_us=` se siguen parseando igual.
//   · stderr se conserva como DIAGNÓSTICO: se guarda una ventana de los últimos
//     N bytes para incluirla en el mensaje de error. Antes el error solo decía
//     "ffmpeg terminó con error (código 1)", que es inaccionable; ahora dice
//     exactamente por qué.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};

/// Bytes de stderr que se conservan para el diagnóstico final.
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// Ventana deslizante de los últimos bytes escritos en stderr.
///
/// No crece sin límite: si el hijo escribe 1 GB de logs, solo se conservan los
/// últimos 8 KB, que son los que importan (el error suele estar al final).
#[derive(Debug, Default)]
pub struct StderrTail {
    buf: Vec<u8>,
}

impl StderrTail {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.buf.extend_from_slice(chunk);
        if self.buf.len() > STDERR_TAIL_BYTES {
            let excess = self.buf.len() - STDERR_TAIL_BYTES;
            self.buf.drain(..excess);
        }
    }

    /// Texto legible del tail. Los bytes inválidos se sustituyen en lugar de
    /// perder todo el diagnóstico por un carácter inválido.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf).trim().to_string()
    }

    /// Últimas `lines` líneas, para no volcar 8 KB de XML en un popup.
    pub fn last_lines(&self, lines: usize) -> String {
        let text = self.text();
        if lines == 0 || text.is_empty() {
            return String::new();
        }
        let all: Vec<&str> = text.lines().collect();
        let from = all.len().saturating_sub(lines);
        all[from..].join("\n")
    }
}

/// Ejecuta `cmd` drenando AMBOS pipes. Invoca `on_stdout_line` por cada línea
/// de stdout (en el hilo actual) y consume stderr en un hilo aparte.
///
/// Devuelve el estado de salida y el tail de stderr. No puede colgarse por
/// culpa de la cantidad de salida del hijo.
pub fn run_capture_streaming<F>(
    cmd: &mut Command,
    mut on_stdout_line: F,
) -> std::io::Result<(ExitStatus, String)>
where
    F: FnMut(&str),
{
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()?;

    // --- stderr: hilo dedicado, nunca bloquea al hijo ---
    let tail = Arc::new(Mutex::new(StderrTail::new()));
    let stderr_thread = child.stderr.take().map(|mut err| {
        let sink = Arc::clone(&tail);
        std::thread::spawn(move || {
            // Lectura por bloques (no por líneas) a propósito: el tail son
            // bytes, y una línea de log puede ser larguísima; además así no
            // falla nunca por una secuencia UTF-8 partida entre dos lecturas.
            let mut buf = [0u8; 8192];
            loop {
                match err.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(mut guard) = sink.lock() {
                            guard.push(&buf[..n]);
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
    });

    // --- stdout: hilo actual, donde vive el progreso ---
    if let Some(out) = child.stdout.take() {
        let reader = BufReader::new(out);
        for line in reader.lines() {
            match line {
                Ok(l) => on_stdout_line(&l),
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }

    // Se espera con stdout ya liberado: si el hijo ainda escribe, el hilo de
    // stderr sigue consumirlo y no se bloquea.
    let status = child.wait()?;

    // El hilo de stderr termina solo cuando el hijo cierra el pipe. Se espera
    // para no dejar un hilo huérfano accessing al tail.
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }

    let tail_text = tail.lock().map(|t| t.text()).unwrap_or_default();
    Ok((status, tail_text))
}

/// Ejecuta capturando ambas salidas sin procesar líneas. Para comandos cortos
/// (probe, listado de formatos) donde el progreso no importa.
pub fn run_capture_both(cmd: &mut Command) -> std::io::Result<(ExitStatus, String, String)> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let tail = Arc::new(Mutex::new(StderrTail::new()));

    let stderr_thread = child.stderr.take().map(|mut err| {
        let sink = Arc::clone(&tail);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match err.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(mut guard) = sink.lock() {
                            guard.push(&buf[..n]);
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
    });

    let mut stdout_buf = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut stdout_buf);
    }

    let status = child.wait()?;
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }

    let stderr_text = tail.lock().map(|t| t.text()).unwrap_or_default();
    Ok((
        status,
        String::from_utf8_lossy(&stdout_buf).to_string(),
        stderr_text,
    ))
}

/// Mensaje de error con el diagnóstico real del proceso.
///
/// Antes: `format!("ffmpeg terminó con error (código {:?}).", s.code())` — sin
/// ninguna información accionable. Ahora incluye las últimas líneas de stderr,
/// que es donde ffmpeg y yt-dlp dicen qué les pasa.
pub fn describe_failure(
    tool: &str,
    status: ExitStatus,
    stderr_tail: &str,
    max_lines: usize,
) -> String {
    let mut tail = StderrTail::new();
    tail.push(stderr_tail.as_bytes());
    let detail = tail.last_lines(max_lines);

    let reason = match status.code() {
        Some(c) => format!("código de salida {}", c),
        None => "terminado por una señal".to_string(),
    };

    if detail.is_empty() {
        format!("{} terminó con error ({}).", tool, reason)
    } else {
        format!("{} terminó con error ({}): {}", tool, reason, detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_conserva_la_ventana_final() {
        let mut t = StderrTail::new();
        // 10 KB de datos: solo deben sobrevivir los últimos 8 KB.
        let chunk = vec![b'x'; 4096];
        t.push(&chunk);
        t.push(&chunk);
        t.push(&chunk);
        assert!(t.buf.len() <= STDERR_TAIL_BYTES);
        assert_eq!(t.buf.len(), STDERR_TAIL_BYTES);
    }

    #[test]
    fn tail_ignora_chunks_vacios() {
        let mut t = StderrTail::new();
        t.push(&[]);
        assert!(t.buf.is_empty());
        assert_eq!(t.text(), "");
    }

    #[test]
    fn tail_texto_quita_espacios_sobrantes() {
        let mut t = StderrTail::new();
        t.push(b"  hola\n\n");
        assert_eq!(t.text(), "hola");
    }

    #[test]
    fn last_lines_devuelve_la_cola() {
        let mut t = StderrTail::new();
        t.push(b"l1\nl2\nl3\nl4\nl5\n");
        assert_eq!(t.last_lines(2), "l4\nl5");
        assert_eq!(t.last_lines(0), "");
        assert_eq!(t.last_lines(99), "l1\nl2\nl3\nl4\nl5");
    }

    #[test]
    fn last_lines_tolera_utf8_invalido() {
        // Un stderr binario o truncado no puede perder todo el diagnóstico por
        // un byte inválido.
        let mut t = StderrTail::new();
        t.push(&[0x41, 0xff, 0xfe, 0x42]);
        assert!(t.text().contains('A'));
        assert!(t.text().contains('B'));
    }

    /// EL test del defecto: un hijo que escribe mucho más que el búfer del pipe
    /// en stderr DEBE completar. Antes se colgaba para siempre.
    ///
    /// Existe en las dos plataformas a propósito: el bug del pipe depende del
    /// tamaño del búfer del kernel (4 KB en Windows, 64 KB en Linux/macOS), así
    /// que un test que solo corre en Unix no demuestra nada en el SO donde se
    /// desarrolla y distribuye el host.
    #[cfg(windows)]
    #[test]
    fn no_se_cuelga_con_stderr_enorme() {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg("for /L %i in (1,1,20000) do @echo linea de log bastante larga para llenar el pipe 0123456789 1>&2 & echo out_ok");
        let mut saw_stdout = false;
        let (status, tail) = run_capture_streaming(&mut cmd, |line| {
            if line.contains("out_ok") {
                saw_stdout = true;
            }
        })
        .expect("spawn");
        assert!(status.success(), "el hijo debe completar con éxito");
        assert!(saw_stdout, "stdout debe leerse completo");
        assert!(!tail.is_empty(), "stderr debe capturarse");
        assert!(
            tail.len() <= STDERR_TAIL_BYTES,
            "el tail debe seguir acotado"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn no_se_cuelga_con_stderr_enorme() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("i=0; while [ $i -lt 20000 ]; do echo 'linea de log bastante larga para llenar el pipe 0123456789' >&2; i=$((i+1)); done; echo out_ok");
        let mut saw_stdout = false;
        let (status, tail) = run_capture_streaming(&mut cmd, |line| {
            if line.contains("out_ok") {
                saw_stdout = true;
            }
        })
        .expect("spawn");
        assert!(status.success(), "el hijo debe completar con éxito");
        assert!(saw_stdout, "stdout debe leerse completo");
        assert!(!tail.is_empty(), "stderr debe capturarse");
        assert!(
            tail.len() <= STDERR_TAIL_BYTES,
            "el tail debe seguir acotado"
        );
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_both_devuelve_ambas_salidas() {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg("echo SALIDA & echo ERROR 1>&2 & exit /B 3");
        let (status, stdout, stderr) = run_capture_both(&mut cmd).expect("spawn");
        assert_eq!(status.code(), Some(3));
        assert!(stdout.contains("SALIDA"), "{}", stdout);
        assert!(stderr.contains("ERROR"), "{}", stderr);
    }

    #[cfg(not(windows))]
    #[test]
    fn run_capture_both_devuelve_ambas_salidas() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("echo SALIDA; echo ERROR >&2; exit 3");
        let (status, stdout, stderr) = run_capture_both(&mut cmd).expect("spawn");
        assert_eq!(status.code(), Some(3));
        assert!(stdout.contains("SALIDA"));
        assert!(stderr.contains("ERROR"));
    }

    #[cfg(not(windows))]
    #[test]
    fn describe_failure_incluye_el_diagnostico() {
        // ExitStatus se construye distinto en cada plataforma; se usa el
        // verificador real del sistema para no depender de `from_raw`.
        let status = real_exit_status(1);
        let msg = describe_failure(
            "ffmpeg",
            status,
            "moov atom not found\nInvalid data found",
            5,
        );
        assert!(msg.contains("ffmpeg"));
        assert!(msg.contains("Invalid data found"), "{}", msg);
    }

    #[test]
    fn describe_failure_sin_stderr_sigue_siendo_util() {
        let status = real_exit_status(0);
        let msg = describe_failure("ffmpeg", status, "", 5);
        assert!(msg.contains("ffmpeg"));
    }

    /// Ejecuta un comando trivial que termina con el código indicado y devuelve
    /// su ExitStatus real, para probar `describe_failure` sin inventarse un
    /// ExitStatus (que es específico de cada SO).
    fn real_exit_status(code: i32) -> ExitStatus {
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd");
            c.arg("/C").arg("exit").arg(code.to_string());
            c.output().expect("cmd").status
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new("sh");
            c.arg("-c").arg(format!("exit {}", code));
            c.output().expect("sh").status
        }
    }
}
