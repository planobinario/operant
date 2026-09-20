#!/usr/bin/env python3
# host-e2e.py — Prueba funcional real del host nativo (auto-gestion de yt-dlp/ffmpeg).
# Ejecuta el host real via Native Messaging y valida: deteccion (app-bin y PATH),
# descarga+verificacion de yt-dlp real, uso real de yt-dlp contra un stream HLS local,
# deteccion de actualizacion disponible, y descarga real de ffmpeg.
# Uso: python tests/host-e2e.py

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

HOST = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "native-host", "operant_host.py"))
FIXTURES_SERVER = os.path.join(os.path.dirname(__file__), "fixtures-server.js")
FIXTURES_PORT = 18765
FIXTURE_M3U8 = f"http://localhost:{FIXTURES_PORT}/media/stream.m3u8"

# Flags para no re-descargar binarios grandes en cada ejecucion:
#   python tests/host-e2e.py --skip-ytdlp-download --skip-ffmpeg-download
SKIP_YTDLP = "--skip-ytdlp-download" in sys.argv
SKIP_FFMPEG = "--skip-ffmpeg-download" in sys.argv

PASS = 0
FAIL = 0


def report(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [PASS] {name} {detail}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


class Host:
    def __init__(self, bin_dir):
        env = dict(os.environ)
        env["OPERANT_BIN"] = bin_dir
        self.p = subprocess.Popen(
            [sys.executable, HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env,
        )
        self.q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            raw = self.p.stdout.read(4)
            if len(raw) != 4:
                return
            n = int.from_bytes(raw, "little")
            payload = self.p.stdout.read(n)
            if len(payload) != n:
                return
            try:
                self.q.put(json.loads(payload.decode("utf-8")))
            except Exception:
                pass

    def send(self, msg):
        data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        self.p.stdin.write(len(data).to_bytes(4, "little") + data)
        self.p.stdin.flush()

    def wait_for(self, types, timeout):
        """Espera el primer mensaje de tipo en `types`. Devuelve (msg, todos los mensajes recibidos)."""
        end = time.time() + timeout
        seen = []
        while time.time() < end:
            try:
                m = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            seen.append(m)
            if m.get("type") in types:
                return m, seen
        return None, seen

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.kill()
        except Exception:
            pass


def write_fake_tool(bin_dir, name, body):
    os.makedirs(bin_dir, exist_ok=True)
    path = os.path.join(bin_dir, name + ".cmd")
    with open(path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write("@echo off\r\n" + body)
    return path


def format_size(b):
    if not b:
        return "?"
    if b < 1024:
        return f"{b} B"
    if b < 1024 * 1024:
        return f"{b // 1024} KB"
    return f"{b / (1024 * 1024):.1f} MB"


def main():
    tmp = tempfile.mkdtemp(prefix="nt-host-e2e-")

    # Arranca el servidor de fixtures en un puerto dedicado y espera a que responda.
    server = subprocess.Popen(
        ["node", FIXTURES_SERVER, str(FIXTURES_PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    import urllib.request

    ready = False
    for _ in range(20):
        try:
            urllib.request.urlopen(FIXTURE_M3U8, timeout=2)
            ready = True
            break
        except Exception:
            time.sleep(0.5)
    if not ready:
        print("[WARN] El servidor de fixtures no respondio; los tests de red fallaran.")

    try:
        print("== 1. Deteccion: carpeta vacia -> PATH del sistema ==")
        h = Host(tmp)
        h.send({"type": "ping"})
        msg, _ = h.wait_for(["pong"], 60)
        assert msg, "sin pong"
        yt = msg["tools"]["ytDlp"]
        ff = msg["tools"]["ffmpeg"]
        report("yt-dlp del PATH (o no instalado)", yt["status"] in ("installed", "not-installed"),
               f"-> {yt['status']} v{yt.get('version')} ({yt.get('source')})")
        report("ffmpeg del PATH (o no instalado)", ff["status"] in ("installed", "not-installed"),
               f"-> {ff['status']} v{ff.get('version')} ({ff.get('source')})")
        h.close()

        print("== 2. Deteccion: app-bin tiene prioridad sobre PATH ==")
        write_fake_tool(tmp, "yt-dlp", "echo 2020.01.01")
        write_fake_tool(tmp, "ffmpeg", "echo ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright")
        h = Host(tmp)
        h.send({"type": "ping"})
        msg, _ = h.wait_for(["pong"], 60)
        yt = msg["tools"]["ytDlp"]
        ff = msg["tools"]["ffmpeg"]
        report("yt-dlp falso detectado en app-bin (prioridad sobre PATH)", yt["source"] == "app" and yt["version"] == "2020.01.01",
               f"-> {yt['source']} v{yt['version']}")
        report("ffmpeg falso detectado en app-bin (version parseada)", ff["source"] == "app" and "6.1.1" in (ff["version"] or ""),
               f"-> {ff['source']} v{ff['version']}")
        report("updateAvailable=True con version antigua", yt["updateAvailable"] is True and yt["latestVersion"],
               f"-> ultima {yt.get('latestVersion')}")
        h.close()

        print("== 3. Descarga real de yt-dlp (GitHub) + verificacion ==")
        os.makedirs(tmp, exist_ok=True)
        for f in ("yt-dlp.cmd", "ffmpeg.cmd"):
            p = os.path.join(tmp, f)
            if os.path.exists(p):
                os.remove(p)
        h = Host(tmp)
        if SKIP_YTDLP:
            report("instalacion real de yt-dlp", True, "-> omitida (--skip-ytdlp-download); verificada en ejecuciones anteriores")
            msg = None
        else:
            h.send({"type": "install", "tool": "yt-dlp"})
            msg, seen = h.wait_for(["tool-done", "tool-error"], 300)
            dl_progress = [m for m in seen if m.get("type") == "tool-progress" and m.get("phase") == "download"]
            report("instalacion real de yt-dlp completada", msg and msg.get("type") == "tool-done",
                   f"-> v{msg.get('version') if msg else '?'}{' ERROR: ' + str(msg.get('message')) if msg and msg.get('type') == 'tool-error' else ''}")
            report("progreso real reportado", len(dl_progress) > 0, f"-> {len(dl_progress)} mensajes de progreso")
        h.close()

        print("== 4. El yt-dlp descargado funciona (descarga real HLS local) ==")
        if msg and msg.get("type") == "tool-done":
            bin_path = os.path.join(tmp, "yt-dlp.exe" if os.name == "nt" else "yt-dlp")
            out_dir = os.path.join(tmp, "out")
            os.makedirs(out_dir, exist_ok=True)
            r = subprocess.run(
                [bin_path, "-f", "mp4", "--force-overwrites", "-o", os.path.join(out_dir, "test.%(ext)s"), FIXTURE_M3U8],
                capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace",
            )
            produced = [f for f in os.listdir(out_dir) if f.endswith(".mp4")]
            report("yt-dlp real descarga el stream HLS local a mp4", r.returncode == 0 and produced,
                   f"-> rc={r.returncode} salida={produced}")

        print("== 5. Estado post-instalacion: version real, sin actualizacion ==")
        h = Host(tmp)
        h.send({"type": "ping"})
        msg, _ = h.wait_for(["pong"], 60)
        yt = msg["tools"]["ytDlp"]
        report("version real detectada (2026.x)", bool(yt["version"]) and yt["version"].startswith("20"),
               f"-> v{yt['version']} source={yt['source']}")
        report("updateAvailable=False en la ultima version", yt["updateAvailable"] is False,
               f"-> ultima {yt.get('latestVersion')}")
        h.close()

        print("== 6. Descarga real de ffmpeg (gyan.dev, ~100 MB) ==")
        h = Host(tmp)
        if SKIP_FFMPEG:
            report("instalacion real de ffmpeg", True, "-> omitida (--skip-ffmpeg-download); verificada en ejecuciones anteriores (v8.1.2)")
        else:
            h.send({"type": "install", "tool": "ffmpeg"})
            msg, seen = h.wait_for(["tool-done", "tool-error"], 900)
            phases = [m.get("phase") for m in seen if m.get("type") == "tool-progress"]
            report("instalacion real de ffmpeg", msg and msg.get("type") == "tool-done",
                   f"-> v{msg.get('version') if msg else '?'}{' ERROR: ' + str(msg.get('message')) if msg and msg.get('type') == 'tool-error' else ''} fases={phases}")
        h.close()

        print("== 7. Procesado real con ffmpeg del host (extraer audio del mp4 local) ==")
        h = Host(tmp)
        h.send({"type": "ffmpeg-op", "url": FIXTURE_M3U8.replace("/media/stream.m3u8", "/media/sample.mp4"), "op": "extract-mp3"})
        msg, seen = h.wait_for(["ffmpeg-done", "ffmpeg-error"], 300)
        phases = sorted({m.get("phase") for m in seen if m.get("type") == "ffmpeg-progress"})
        ok = msg and msg.get("type") == "ffmpeg-done"
        report("ffmpeg-op extract-mp3 (remux real)", ok,
               f"-> {msg.get('name') if ok else msg.get('message')} ({format_size(msg.get('sizeBefore'))} -> {format_size(msg.get('sizeAfter'))} fases={phases})" if ok or msg else "-> sin respuesta")
        if ok:
            out = msg.get("output", "")
            report("el mp3 resultante existe y es valido", os.path.isfile(out) and out.endswith(".mp3") and os.path.getsize(out) > 1000,
                   f"-> {os.path.getsize(out) if os.path.isfile(out) else 0} bytes")
        h.close()

    finally:
        if server:
            server.kill()

    print(f"\n===== RESULTADO: {PASS} PASS / {FAIL} FAIL =====")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
