#!/usr/bin/env python3
# host-e2e-linux.py — Verificacion Linux del host nativo (ejecutar DENTRO de WSL/Linux).
# Cubre lo que no se puede probar en Windows: deteccion con nombres sin extension,
# extraccion del tar.xz de BtbN, chmod +x, y el check de version via redirect.
# Uso (en WSL): python3 tests/host-e2e-linux.py [--skip-ffmpeg-download]

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

HOST = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "native-host", "operant_host.py"))
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
    path = os.path.join(bin_dir, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, 0o755)
    return path


def main():
    tmp = tempfile.mkdtemp(prefix="operant-host-linux-")

    print("== 1. Deteccion: fakes sin extension en app-bin ==")
    write_fake_tool(tmp, "yt-dlp", 'echo 2021.05.05')
    write_fake_tool(tmp, "ffmpeg", 'echo ffmpeg version 5.1.2-whatever Copyright')
    h = Host(tmp)
    h.send({"type": "ping"})
    msg, _ = h.wait_for(["pong"], 60)
    yt = msg["tools"]["ytDlp"]
    ff = msg["tools"]["ffmpeg"]
    report("yt-dlp detectado en app-bin (nombre sin extension)", yt["source"] == "app" and yt["version"] == "2021.05.05",
           f"-> {yt['source']} v{yt['version']}")
    report("ffmpeg detectado en app-bin", ff["source"] == "app" and "5.1.2" in (ff["version"] or ""),
           f"-> {ff['source']} v{ff['version']}")
    report("updateAvailable=True y ultima version por redirect", yt["updateAvailable"] is True and bool(yt["latestVersion"]),
           f"-> ultima {yt.get('latestVersion')}")
    h.close()

    print("== 2. Descarga real de yt-dlp (binario Linux) + chmod +x ==")
    for f in ("yt-dlp", "ffmpeg"):
        p = os.path.join(tmp, f)
        if os.path.exists(p):
            os.remove(p)
    h = Host(tmp)
    h.send({"type": "install", "tool": "yt-dlp"})
    msg, seen = h.wait_for(["tool-done", "tool-error"], 300)
    report("instalacion real de yt-dlp en Linux", msg and msg.get("type") == "tool-done",
           f"-> v{msg.get('version') if msg else '?'}{' ERROR: ' + str(msg.get('message')) if msg and msg.get('type') == 'tool-error' else ''}")
    if msg and msg.get("type") == "tool-done":
        exe = os.path.join(tmp, "yt-dlp")
        report("permisos de ejecucion (chmod +x)", os.access(exe, os.X_OK), f"-> {oct(os.stat(exe).st_mode & 0o777)}")
        r = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30)
        report("el binario Linux ejecuta --version", r.returncode == 0 and r.stdout.strip(),
               f"-> {r.stdout.strip()[:40]}")
    h.close()

    print("== 3. Descarga real de ffmpeg (tar.xz BtbN) + extraccion + chmod ==")
    if SKIP_FFMPEG:
        report("instalacion real de ffmpeg Linux", True, "-> omitida (--skip-ffmpeg-download)")
    else:
        h = Host(tmp)
        h.send({"type": "install", "tool": "ffmpeg"})
        msg, seen = h.wait_for(["tool-done", "tool-error"], 1200)
        phases = sorted({m.get("phase") for m in seen if m.get("type") == "tool-progress"})
        report("instalacion real de ffmpeg (BtbN tar.xz)", msg and msg.get("type") == "tool-done",
               f"-> v{msg.get('version') if msg else '?'}{' ERROR: ' + str(msg.get('message')) if msg and msg.get('type') == 'tool-error' else ''} fases={phases}")
        if msg and msg.get("type") == "tool-done":
            exe = os.path.join(tmp, "ffmpeg")
            report("ffmpeg ejecutable (chmod +x)", os.access(exe, os.X_OK))
            r = subprocess.run([exe, "-version"], capture_output=True, text=True, timeout=30)
            report("ffmpeg Linux ejecuta -version", r.returncode == 0, f"-> {r.stdout.splitlines()[0][:60] if r.stdout else '?'}")
        h.close()

    print(f"\n===== RESULTADO LINUX: {PASS} PASS / {FAIL} FAIL =====")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
