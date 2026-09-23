#!/usr/bin/env python3
# operant_host.py — Host nativo de Operant (Native Messaging).
# Puente entre la extension (sandbox) y el sistema operativo:
#   - Detecta yt-dlp / ffmpeg (carpeta propia de la app primero, luego PATH)
#   - Los descarga e instala automaticamente si faltan (sin tocar el sistema)
#   - Comprueba actualizaciones (redirect de GitHub, cache de 24 h) y actualiza de forma atomica
#   - Ejecuta yt-dlp para descargas de maxima calidad con progreso real
#   - Procesa medios con ffmpeg real (remux, extraer audio, comprimir, redimensionar)
#     con progreso real y comparacion de tamanos antes/despues
# Solo Python stdlib. El propio host requiere instalacion manual una vez
# (install_host.bat / .sh) — eso no se puede automatizar por seguridad del navegador.

import base64
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import urllib.error
import uuid
import zipfile

HOST_NAME = "com.operant.native_host"
GH_UA = "operant/0.4"
CACHE_TTL_SECONDS = 24 * 3600
YTDLP_DL_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
GYAN_FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
BTBN_DL_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/"

# Operaciones de procesado de medios (Parte C): args ffmpeg por operacion.
FFMPEG_OPS = {
    "extract-mp3": {"ext": "mp3", "args": lambda o: ["-vn", "-c:a", "libmp3lame", "-b:a", "192k"]},
    "remux-mp4": {"ext": "mp4", "args": lambda o: ["-c", "copy", "-movflags", "+faststart"]},
    "convert-webm": {"ext": "webm", "args": lambda o: ["-c:v", "libvpx", "-crf", "30", "-b:v", "2M", "-c:a", "libopus"]},
    "compress": {"ext": "mp4", "args": lambda o: ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(o.get("crf", 28)), "-c:a", "aac"]},
    "resize-50": {"ext": "mp4", "args": lambda o: ["-vf", "scale=iw*0.5:ih*0.5", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]},
    "img-jpg": {"ext": "jpg", "args": lambda o: ["-q:v", "2"]},
    "img-webp": {"ext": "webm", "args": lambda o: ["-q:v", "75"]},
    # HLS/DASH: ffmpeg lee el manifiesto directamente por URL y lo reensambla
    # a un mp4 (concat de segmentos). Sin descarga previa del manifiesto.
    "hls-dash": {"ext": "mp4", "url_input": True, "args": lambda o: ["-c", "copy", "-movflags", "+faststart"]},
    # DASH con vídeo y audio SEPARADOS (Reddit, Instagram, etc.): une dos
    # streams (video-only + audio-only) en un solo mp4. No es url_input: se
    # descargan ambos archivos y se pasan como dos inputs a ffmpeg.
    "dash-merge": {"ext": "mp4", "args": lambda o: ["-c", "copy", "-movflags", "+faststart"]},
}

TOOLS = {
    "yt-dlp": {"version_arg": "--version", "version_re": r"\d{4}\.\d{2}\.\d{2}"},
    "ffmpeg": {"version_arg": "-version", "version_re": None},
    "ffprobe": {"version_arg": "-version", "version_re": None},
}


# ---------- utilidades ----------

def send_message(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(len(data).to_bytes(4, "little") + data)
    sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) != 4:
        return None
    length = int.from_bytes(raw, "little")
    if length <= 0 or length > 1_048_576:
        return None
    try:
        return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def bin_dir():
    override = os.environ.get("OPERANT_BIN")
    if override:
        return override
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return os.path.join(base, "Operant", "bin")
    return os.path.join(os.path.expanduser("~"), "Operant", "bin")


def state_path():
    return os.path.join(os.path.dirname(bin_dir()), "state.json")


def is_windows():
    return os.name == "nt"


def exe_name(tool):
    return TOOLS[tool] and (tool + (".exe" if is_windows() else ""))


def tool_candidates(tool):
    if is_windows():
        pathext = os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";")
        return [tool + ext.lower() for ext in pathext if ext]
    return [tool]


# ---------- deteccion y version ----------

# En Windows, lanzar un subproceso de consola (yt-dlp.exe/ffmpeg.exe) mientras el
# hilo principal esta bloqueado leyendo stdin (pipe) causa un deadlock en la
# creacion de consola. CREATE_NO_WINDOW evita la asignacion de consola.
def subprocess_flags():
    if is_windows():
        return 0x08000000  # CREATE_NO_WINDOW
    return 0


def run_capture(path, arg):
    try:
        r = subprocess.run(
            [path, arg], capture_output=True, text=True, timeout=20,
            encoding="utf-8", errors="replace",
            creationflags=subprocess_flags(), stdin=subprocess.DEVNULL,
        )
        if r.returncode != 0:
            return None
        return ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
    except Exception:
        return None


def parse_ytdlp_version(raw):
    m = re.search(r"(\d{4}\.\d{2}\.\d{2})", raw or "")
    return m.group(1) if m else None


def parse_ffmpeg_version(raw):
    if not raw:
        return None
    line = raw.splitlines()[0].strip()[:80]
    return line or None


def detect(tool):
    """Busca la herramienta: 1) carpeta de la app, 2) PATH. Devuelve dict o None."""
    for cand in tool_candidates(tool):
        p = os.path.join(bin_dir(), cand)
        if os.path.isfile(p):
            raw = run_capture(p, TOOLS[tool]["version_arg"])
            if raw:
                return {"path": p, "source": "app", "raw": raw}
    found = shutil.which(tool)
    if found:
        raw = run_capture(found, TOOLS[tool]["version_arg"])
        if raw:
            return {"path": found, "source": "system", "raw": raw}
    return None


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def parse_version(tool, raw):
    if tool == "yt-dlp":
        return parse_ytdlp_version(raw)
    return parse_ffmpeg_version(raw)


# ---------- ultima version (GitHub API, cache 24 h) ----------

def load_cache():
    try:
        with open(state_path(), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(cache):
    try:
        os.makedirs(os.path.dirname(state_path()), exist_ok=True)
        with open(state_path(), "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception:
        pass


def fetch_ytdlp_latest():
    """Ultima version de yt-dlp sin usar la API de GitHub (evita rate-limits):
    releases/latest/download redirige a /releases/download/<VERSION>/; capturamos
    el Location del primer redirect sin seguirlo. Cache de 24 h.
    Si el parseo falla (p.ej. GitHub cambia el redirect), se registra un error
    VISIBLE en la cache para que el panel lo muestre en vez de mentir con
    "sin actualizaciones"."""
    now = time.time()
    cache = load_cache()
    entry = dict(cache.get("yt-dlp-latest") or {})
    if entry and now - entry.get("checkedAt", 0) <= CACHE_TTL_SECONDS:
        return entry.get("tag")
    try:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

        opener = urllib.request.build_opener(NoRedirect)
        req = urllib.request.Request(YTDLP_DL_URL + "yt-dlp", headers={"User-Agent": GH_UA}, method="HEAD")
        try:
            opener.open(req, timeout=20)
            location = ""
            error = "el enlace no redirige (comportamiento inesperado de GitHub)"
        except urllib.error.HTTPError as exc:
            location = exc.headers.get("Location", "")
            error = None
        m = re.search(r"/releases/download/([\w.\-]+)/", location)
        tag = m.group(1).lstrip("v") if m else None
        if tag and re.match(r"^\d{4}\.\d{2}\.\d{2}$", tag):
            entry = {"tag": tag, "checkedAt": now}
            entry.pop("lastError", None)
        else:
            error = f"no se pudo extraer la version del redirect (Location={location[:80]!r})"
            entry = {"tag": None, "checkedAt": now, "lastError": error}
        cache["yt-dlp-latest"] = entry
        save_cache(cache)
    except Exception as exc:  # noqa: BLE001
        entry = {"tag": None, "checkedAt": now, "lastError": f"fallo de red: {exc}"}
        cache["yt-dlp-latest"] = entry
        save_cache(cache)
    return entry.get("tag")


# ---------- descargas ----------

def looks_like_real_media(path):
    """Verifica que un archivo descargado parece contenido multimedia real y no
    un init segment vacío (solo moov/trak, cero muestras) ni texto plano.
    Un fMP4/DASH válido con datos tiene un box 'mdat' o 'moof' con contenido."""
    try:
        size = os.path.getsize(path)
        if size < 1024:
            return False  # un vídeo real de segundos no pesa <1KB
        with open(path, "rb") as f:
            head = f.read(64)
        if head.startswith(b"#EXTM3U") or head.lstrip().startswith(b"<") or head.startswith(b"{"):
            return False  # manifiesto / XML / JSON de error
        if not head.startswith(b"\x00\x00\x00"):
            return False  # no es un box MP4
        # Buscar boxes mdat/moof en los primeros 256KB (contenido real).
        with open(path, "rb") as f:
            sample = f.read(262144)
        for marker in (b"mdat", b"moof"):
            if marker in sample:
                return True
        return False
    except OSError:
        return False


def download(url, dest, on_progress):
    req = urllib.request.Request(url, headers={"User-Agent": GH_UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    on_progress(min(99, int(got * 100 / total)))


def progress_msg(tool, phase, progress):
    send_message({"type": "tool-progress", "tool": tool, "phase": phase, "progress": progress})


def verify_and_install(tool, tmp_exe, final_exe):
    """Verifica (funcional) el binario descargado y lo instala de forma atomica."""
    if not is_windows():
        # En Unix el binario debe ser ejecutable ANTES de poder verificarlo.
        try:
            os.chmod(tmp_exe, os.stat(tmp_exe).st_mode | 0o111)
        except OSError:
            pass
    raw = run_capture(tmp_exe, TOOLS[tool]["version_arg"])
    version = parse_version(tool, raw)
    if not version:
        try:
            os.remove(tmp_exe)
        except OSError:
            pass
        send_message({"type": "tool-error", "tool": tool, "message": "El binario descargado no responde: descarga corrupta o incompatible."})
        return
    os.makedirs(os.path.dirname(final_exe), exist_ok=True)
    os.replace(tmp_exe, final_exe)  # reemplazo atomico: nunca deja el sistema a medias
    if not is_windows():
        os.chmod(final_exe, os.stat(final_exe).st_mode | 0o111)
    send_message({"type": "tool-done", "tool": tool, "version": version, "path": final_exe})


def install_ytdlp():
    tool = "yt-dlp"
    bd = bin_dir()
    os.makedirs(bd, exist_ok=True)
    asset = "yt-dlp.exe" if is_windows() else "yt-dlp"
    tmp = os.path.join(bd, "yt-dlp.new.exe" if is_windows() else "yt-dlp.new")
    final = os.path.join(bd, asset)
    try:
        progress_msg(tool, "download", 0)
        download(YTDLP_DL_URL + asset, tmp, lambda p: progress_msg(tool, "download", p))
        progress_msg(tool, "verify", 99)
        verify_and_install(tool, tmp, final)
    except Exception as exc:  # noqa: BLE001
        try:
            os.remove(tmp)
        except OSError:
            pass
        send_message({"type": "tool-error", "tool": tool, "message": f"Fallo al descargar yt-dlp: {exc}"})


def extract_ffmpeg_assets(bd):
    """Descarga y extrae ffmpeg(+ffprobe). Devuelve lista de (tool, tmp, final)."""
    if is_windows():
        zip_path = os.path.join(bd, "ffmpeg.download.zip")
        download(GYAN_FFMPEG_URL, zip_path, lambda p: progress_msg("ffmpeg", "download", p))
        progress_msg("ffmpeg", "extract", 95)
        pairs = []
        with zipfile.ZipFile(zip_path) as z:
            for m in z.namelist():
                name = os.path.basename(m)
                if name in ("ffmpeg.exe", "ffprobe.exe"):
                    data = z.read(m)
                    tool = name[:-4]
                    tmp = os.path.join(bd, f"{tool}.new.exe")
                    with open(tmp, "wb") as f:
                        f.write(data)
                    pairs.append((tool, tmp, os.path.join(bd, name)))
        os.remove(zip_path)
        return pairs
    # Linux / macOS: builds estaticos de BtbN (GitHub)
    if sys.platform.startswith("linux"):
        asset = "ffmpeg-master-latest-linux64-gpl.tar.xz"
    else:
        asset = "ffmpeg-master-latest-macosarm64-gpl.zip" if platform.machine().lower() in ("arm64", "aarch64") else "ffmpeg-master-latest-macos64-gpl.zip"
    archive = os.path.join(bd, "ffmpeg.download" + (".tar.xz" if asset.endswith("xz") else ".zip"))
    download(BTBN_DL_URL + asset, archive, lambda p: progress_msg("ffmpeg", "download", p))
    progress_msg("ffmpeg", "extract", 95)
    extract_dir = os.path.join(bd, "ffmpeg.extract")
    if asset.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for m in z.namelist():
                if os.path.basename(m) in ("ffmpeg", "ffprobe") and "/bin/" in m.name:
                    data = z.read(m)
                    os.makedirs(extract_dir, exist_ok=True)
                    with open(os.path.join(extract_dir, os.path.basename(m)), "wb") as f:
                        f.write(data)
    else:
        with tarfile.open(archive, "r:xz") as t:
            for m in t.getmembers():
                if os.path.basename(m.name) in ("ffmpeg", "ffprobe") and "/bin/" in m.name:
                    f = t.extractfile(m)
                    if f:
                        os.makedirs(extract_dir, exist_ok=True)
                        with open(os.path.join(extract_dir, os.path.basename(m.name)), "wb") as out:
                            out.write(f.read())
    os.remove(archive)
    return [(tool, os.path.join(extract_dir, tool), os.path.join(bd, tool)) for tool in ("ffmpeg", "ffprobe")]


def install_ffmpeg():
    bd = bin_dir()
    os.makedirs(bd, exist_ok=True)
    try:
        progress_msg("ffmpeg", "download", 0)
        pairs = extract_ffmpeg_assets(bd)
        progress_msg("ffmpeg", "verify", 99)
        for tool, tmp, final in pairs:
            verify_and_install(tool, tmp, final)
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "tool-error", "tool": "ffmpeg", "message": f"Fallo al instalar ffmpeg: {exc}"})


# ---------- estado ----------

def tool_status(tool):
    det = detect(tool)
    if not det:
        return {
            "tool": tool, "status": "not-installed", "path": None, "version": None,
            "source": None, "updateAvailable": False, "latestVersion": None,
            "updateCheckError": None,
        }
    version = parse_version(tool, det["raw"])
    latest = None
    update_available = False
    update_check_error = None
    if tool == "yt-dlp":
        latest = fetch_ytdlp_latest()
        if latest and version:
            try:
                update_available = version_tuple(latest) > version_tuple(version)
            except ValueError:
                update_available = False
        cache = load_cache().get("yt-dlp-latest") or {}
        if not latest:
            update_check_error = cache.get("lastError") or "no se pudo comprobar la ultima version"
    return {
        "tool": tool, "status": "installed", "path": det["path"],
        "version": version, "source": det["source"],
        "updateAvailable": update_available, "latestVersion": latest,
        "updateCheckError": update_check_error,
    }


def tools_status():
    return {"ytDlp": tool_status("yt-dlp"), "ffmpeg": tool_status("ffmpeg")}


# ---------- descarga de medios con yt-dlp ----------

OUTPUT_DIR = os.path.join(os.path.expanduser("~"), "Downloads", "Operant")


def list_ytdlp_formats(url):
    """Lista las calidades disponibles con `yt-dlp -F` (paridad FetchV)."""
    det = detect("yt-dlp")
    if not det:
        send_message({"type": "formats-error", "message": "yt-dlp no esta instalado. Abre el panel -> Herramientas -> Instalar."})
        return
    try:
        r = subprocess.run(
            [det["path"], "-F", "--no-download", url],
            capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace",
            creationflags=subprocess_flags(), stdin=subprocess.DEVNULL,
        )
        raw = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
        if r.returncode != 0:
            send_message({"type": "formats-error", "message": f"yt-dlp -F fallo (codigo {r.returncode})."})
            return
        formats = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith(("-", "ID", "──")):
                continue
            fields = line.split()
            if not fields or not re.match(r"^\d+$", fields[0]):
                continue
            fmt = {"id": fields[0], "ext": fields[1] if len(fields) > 1 else "", "note": line}
            formats.append(fmt)
        send_message({"type": "formats", "url": url, "formats": formats})
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "formats-error", "message": f"Error al listar formatos: {exc}"})


def run_ytdl(url, fmt_id=None):
    det = detect("yt-dlp")
    if not det:
        send_message({"type": "error", "message": "yt-dlp no esta instalado. Abre el panel -> Herramientas -> Instalar."})
        return
    if not detect("ffmpeg"):
        send_message({"type": "error", "message": "ffmpeg no esta instalado (necesario para unir video+audio). Panel -> Herramientas -> Instalar."})
        return
    # Calidad elegida por el usuario, o maxima por defecto.
    # Si es extracción de audio (bestaudio/audio-only): usar -x --audio-format mp3
    # en vez de merge a mp4 (que fallaría sin pista de vídeo).
    audio_only = fmt_id and fmt_id.lower().startswith("bestaudio")
    fmt_arg = f"-f{fmt_id}" if fmt_id else "-f bestvideo*+bestaudio/best"
    cmd = [
        det["path"],
        fmt_arg,
        "--newline",
        "-o", os.path.join(OUTPUT_DIR, "%(title).120s [%(id)s].%(ext)s"),
        url,
    ]
    if audio_only:
        cmd += ["-x", "--audio-format", "mp3", "--audio-quality", "0"]
    else:
        cmd += ["--merge-output-format", "mp4"]
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
            creationflags=subprocess_flags(),
        )
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "error", "message": f"Error al lanzar yt-dlp: {exc}"})
        return
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        send_message({"type": "progress", "line": line[:300]})
        if "[download]" in line and "%" in line:
            try:
                pct = float(line.split("]")[1].split("%")[0].strip())
                send_message({"type": "progress-pct", "percent": pct})
            except ValueError:
                pass
    proc.wait()
    if proc.returncode == 0:
        send_message({"type": "done", "folder": OUTPUT_DIR})
    else:
        send_message({"type": "error", "message": f"yt-dlp termino con error (codigo {proc.returncode}). Revisa los mensajes anteriores."})


# ---------- procesado de medios con ffmpeg real (Parte C) ----------

def probe_duration(ffmpeg_path, src):
    probe = os.path.join(os.path.dirname(ffmpeg_path), "ffprobe" + (".exe" if is_windows() else ""))
    if not os.path.isfile(probe):
        return None
    try:
        r = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
            capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace",
            creationflags=subprocess_flags(), stdin=subprocess.DEVNULL,
        )
        raw = (r.stdout or "").strip()
        return float(raw) if r.returncode == 0 and raw else None
    except Exception:
        return None


def run_ffmpeg_op(url, op, options):
    if op not in FFMPEG_OPS:
        send_message({"type": "ffmpeg-error", "message": f"Operacion desconocida: {op}"})
        return
    ffmpeg = detect("ffmpeg")
    if not ffmpeg:
        send_message({"type": "ffmpeg-error", "message": "ffmpeg no esta instalado. Abre el panel -> Herramientas -> Instalar."})
        return
    workdir = None
    try:
        name = os.path.basename(urllib.request.url2pathname(url.split("?")[0]))
        base = re.sub(r"\.[^.]+$", "", name) or "media"
        # Si el SW pasa un filename (p.ej. el nombre original del manifiesto),
        # usarlo como base del nombre de salida en vez del genérico base_op.
        opt_filename = (options or {}).get("filename")
        if opt_filename:
            base = re.sub(r"\.[^.]+$", "", os.path.basename(str(opt_filename))) or base
        out_name = f"{base}_{op}.{FFMPEG_OPS[op]['ext']}"
        out_path = os.path.join(OUTPUT_DIR, out_name)
        os.makedirs(OUTPUT_DIR, exist_ok=True)

        op_cfg = FFMPEG_OPS[op]
        duration = None
        size_before = 0
        if op == "dash-merge":
            # DASH con vídeo y audio separados: descargar ambos y pasarlos
            # como dos inputs a ffmpeg (-i video -i audio -c copy).
            video_url = (options or {}).get("videoUrl") or url
            audio_url = (options or {}).get("audioUrl") or ""
            if not audio_url:
                send_message({"type": "ffmpeg-error", "message": "Falta la URL de audio (DASH con track separado)."})
                return
            workdir = tempfile.mkdtemp(prefix="operant-ffmpeg-")
            src_v = os.path.join(workdir, "video.mp4")
            src_a = os.path.join(workdir, "audio.mp4")
            send_message({"type": "ffmpeg-progress", "phase": "download", "progress": 0})
            # Si vienen listas de segmentos (init + media del .mpd), descargar
            # y concatenar cada track (fMP4/DASH de X). Si no, una sola URL.
            video_segs = (options or {}).get("videoSegments") or []
            audio_segs = (options or {}).get("audioSegments") or []
            if video_segs and audio_segs:
                def concat_segments(urls, dest, progress_base, progress_span):
                    parts = []
                    for i, u in enumerate(urls):
                        p = os.path.join(workdir, f"vpart_{len(parts)}.mp4")
                        download(u, p, lambda pr, i=i: send_message({"type": "ffmpeg-progress", "phase": "download", "progress": progress_base + int(progress_span * (i + pr / 100) / len(urls))}))
                        parts.append(p)
                    with open(dest, "wb") as out:
                        for p in parts:
                            with open(p, "rb") as f:
                                out.write(f.read())
                    return sum(os.path.getsize(p) for p in parts)
                size_v = concat_segments(video_segs, src_v, 0, 45)
                size_a = concat_segments(audio_segs, src_a, 45, 50)
                send_message({"type": "ffmpeg-progress", "phase": "process", "progress": 0})
                duration = probe_duration(ffmpeg["path"], src_v)
                size_before = size_v + size_a
                # Verificación: el track de vídeo concatenado no debe ser un
                # init segment vacío (cero muestras, solo moov/trak) ni texto.
                if not looks_like_real_media(src_v):
                    send_message({"type": "ffmpeg-error", "message": "El vídeo descargado parece un init segment vacío o contenido no válido (DASH). Reproduce el vídeo en la página y vuelve a intentarlo."})
                    return
            else:
                download(video_url, src_v, lambda p: send_message({"type": "ffmpeg-progress", "phase": "download", "progress": p // 2}))
                send_message({"type": "ffmpeg-progress", "phase": "download", "progress": 50})
                download(audio_url, src_a, lambda p: send_message({"type": "ffmpeg-progress", "phase": "download", "progress": 50 + p // 2}))
                send_message({"type": "ffmpeg-progress", "phase": "process", "progress": 0})
                duration = probe_duration(ffmpeg["path"], src_v)
                size_before = os.path.getsize(src_v) + os.path.getsize(src_a)
            args = ["-i", src_a, "-c", "copy", "-movflags", "+faststart"]
            cmd = [ffmpeg["path"], "-y", "-i", src_v, *args, "-progress", "pipe:1", "-nostats", out_path]
        elif op_cfg.get("url_input"):
            # HLS/DASH: ffmpeg lee el manifiesto por URL (concat de segmentos).
            src_arg = url
            send_message({"type": "ffmpeg-progress", "phase": "process", "progress": 0})
            duration = probe_duration(ffmpeg["path"], src_arg)
            args = op_cfg["args"](options or {})
            cmd = [ffmpeg["path"], "-y", "-i", src_arg, *args, "-progress", "pipe:1", "-nostats", out_path]
        else:
            workdir = tempfile.mkdtemp(prefix="operant-ffmpeg-")
            src = os.path.join(workdir, "input" + (os.path.splitext(name)[1] or ""))
            send_message({"type": "ffmpeg-progress", "phase": "download", "progress": 0})
            download(url, src, lambda p: send_message({"type": "ffmpeg-progress", "phase": "download", "progress": p}))
            size_before = os.path.getsize(src)
            src_arg = src
            send_message({"type": "ffmpeg-progress", "phase": "process", "progress": 0})
            duration = probe_duration(ffmpeg["path"], src_arg)
            args = op_cfg["args"](options or {})
            cmd = [ffmpeg["path"], "-y", "-i", src_arg, *args, "-progress", "pipe:1", "-nostats", out_path]

        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
            creationflags=subprocess_flags(),
        )
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("out_time_us="):
                try:
                    us = int(line.split("=", 1)[1])
                    if duration:
                        pct = min(99, int(us / 1e6 / duration * 100))
                        send_message({"type": "ffmpeg-progress", "phase": "process", "progress": pct})
                except (ValueError, ZeroDivisionError):
                    pass
        proc.wait()
        if proc.returncode != 0:
            send_message({"type": "ffmpeg-error", "message": f"ffmpeg termino con error (codigo {proc.returncode})."})
            return
        size_after = os.path.getsize(out_path)
        send_message({
            "type": "ffmpeg-done", "output": out_path, "name": out_name,
            "sizeBefore": size_before, "sizeAfter": size_after,
        })
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "ffmpeg-error", "message": f"Error en el procesado: {exc}"})
    finally:
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)


# ---------- sesiones de grabacion (buffers MSE del reproductor) ----------
# La extension envia los buffers capturados del reproductor en trozos base64
# (< 1 MB por mensaje: el cap de read_message mata el host si se supera) y el
# host los acumula en archivos temporales por pista. Al cerrar, ffmpeg remuxa
# con faststart. El fMP4 concatenado (init + media) ya es valido sin recodificar.

rec_sessions = {}  # session_id -> {"dir", "paths": {track: file}}
rec_lock = threading.Lock()


def _rec_begin():
    session = uuid.uuid4().hex[:12]
    workdir = tempfile.mkdtemp(prefix="operant-rec-")
    paths = {
        "video": os.path.join(workdir, "video.bin"),
        "audio": os.path.join(workdir, "audio.bin"),
    }
    for path in paths.values():
        open(path, "wb").close()
    with rec_lock:
        rec_sessions[session] = {"dir": workdir, "paths": paths}
    send_message({"type": "rec-beginned", "session": session})


def _rec_append(session, track, data):
    with rec_lock:
        sess = rec_sessions.get(session)
    if not sess or track not in sess["paths"]:
        send_message({"type": "rec-error", "session": session, "message": "Sesion de grabacion invalida."})
        return
    try:
        raw = base64.b64decode(data)
        with open(sess["paths"][track], "ab") as f:
            f.write(raw)
        send_message({"type": "rec-appended", "session": session, "bytes": len(raw)})
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "rec-error", "session": session, "message": str(exc)})


def _rec_end(session, filename):
    with rec_lock:
        sess = rec_sessions.pop(session, None)
    if not sess:
        send_message({"type": "rec-error", "session": session, "message": "Sesion de grabacion invalida."})
        return
    threading.Thread(target=_rec_finish, args=(sess, filename), daemon=True).start()


def _rec_cancel(session):
    with rec_lock:
        sess = rec_sessions.pop(session, None)
    if sess:
        shutil.rmtree(sess["dir"], ignore_errors=True)
    send_message({"type": "rec-cancelled", "session": session})


def _rec_finish(sess, filename):
    workdir = sess["dir"]
    try:
        ffmpeg = detect("ffmpeg")
        if not ffmpeg:
            send_message({"type": "rec-error", "message": "ffmpeg no esta instalado. Abre el panel -> Herramientas -> Instalar."})
            return
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        base = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(filename or "")).strip() or "grabacion"
        base = re.sub(r"\.[^.]+$", "", base)
        out_path = os.path.join(OUTPUT_DIR, f"{base}.mp4")
        n = 1
        while os.path.exists(out_path):
            out_path = os.path.join(OUTPUT_DIR, f"{base} ({n}).mp4")
            n += 1

        vpath = sess["paths"]["video"]
        apath = sess["paths"]["audio"]
        has_video = os.path.getsize(vpath) > 1024
        has_audio = os.path.getsize(apath) > 1024
        if not has_video and not has_audio:
            send_message({"type": "rec-error", "message": "La grabacion no contiene datos."})
            return

        send_message({"type": "ffmpeg-progress", "phase": "process", "progress": 0})
        args = [ffmpeg["path"], "-y"]
        if has_video:
            args += ["-i", vpath]
        if has_audio:
            args += ["-i", apath]
        args += ["-c", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out_path]
        proc = subprocess.run(args, capture_output=True, text=True, timeout=3600, encoding="utf-8", errors="replace")
        if proc.returncode != 0 or not looks_like_real_media(out_path):
            tail = (proc.stderr or "")[-400:]
            send_message({"type": "rec-error", "message": f"ffmpeg no pudo ensamblar la grabacion: {tail}"})
            return
        send_message({
            "type": "ffmpeg-done",
            "output": out_path,
            "name": os.path.basename(out_path),
            "sizeAfter": os.path.getsize(out_path),
        })
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "rec-error", "message": str(exc)})
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------- ruteo ----------

installing = set()
install_lock = threading.Lock()


def handle(msg):
    msg_type = msg.get("type")
    if msg_type == "ping":
        send_message({"type": "pong", "tools": tools_status()})
    elif msg_type == "check-updates":
        # Fuerza refresco de la cache de versiones
        try:
            fetch_ytdlp_latest()
        except Exception:
            pass
        send_message({"type": "tools-status", "tools": tools_status()})
    elif msg_type in ("install", "update") and msg.get("tool") in TOOLS:
        tool = msg["tool"]
        with install_lock:
            if tool in installing:
                send_message({"type": "tool-error", "tool": tool, "message": "Ya hay una instalacion en curso."})
                return
            installing.add(tool)
        threading.Thread(target=_update_tool, args=(tool,), daemon=True).start()
    elif msg_type == "ytdl":
        url = msg.get("url", "")
        if not url:
            send_message({"type": "error", "message": "URL vacia."})
            return
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        threading.Thread(target=run_ytdl, args=(url, msg.get("format")), daemon=True).start()
    elif msg_type == "ytdl-list-formats":
        url = msg.get("url", "")
        if not url:
            send_message({"type": "formats-error", "message": "URL vacia."})
            return
        threading.Thread(target=list_ytdlp_formats, args=(url,), daemon=True).start()
    elif msg_type == "ffmpeg-op":
        url = msg.get("url", "")
        if not url:
            send_message({"type": "ffmpeg-error", "message": "URL vacia."})
            return
        threading.Thread(
            target=run_ffmpeg_op, args=(url, msg.get("op", ""), msg.get("options") or {}), daemon=True
        ).start()
    elif msg_type == "rec-begin":
        _rec_begin()
    elif msg_type == "rec-append":
        # Sincrono y en el orden de llegada: reordenar chunks corromperia el
        # archivo. Es una escritura a disco rapida; el ffmpeg final si va en
        # hilo propia via _rec_end.
        _rec_append(msg.get("session", ""), msg.get("track", "video"), msg.get("data", ""))
    elif msg_type == "rec-end":
        _rec_end(msg.get("session", ""), msg.get("filename"))
    elif msg_type == "rec-cancel":
        _rec_cancel(msg.get("session", ""))
    else:
        send_message({"type": "error", "message": f"Tipo de mensaje desconocido: {msg_type}"})


def _update_tool(tool):
    # El flujo de actualizacion es el mismo que la instalacion: descarga a
    # temporal, verifica, y reemplaza de forma atomica (verify_and_install).
    try:
        if tool == "yt-dlp":
            install_ytdlp()
        else:
            install_ffmpeg()
    finally:
        with install_lock:
            installing.discard(tool)


def main():
    while True:
        msg = read_message()
        if msg is None:
            break
        try:
            handle(msg)
        except Exception as exc:  # noqa: BLE001
            send_message({"type": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
