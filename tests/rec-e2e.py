#!/usr/bin/env python3
"""Test e2e de las ops rec-begin/rec-append/rec-end del host nativo.
Hereda el mecanismo de framing real (4 bytes LE + JSON) de host-e2e.py.
Requiere ffmpeg detectable por el host (PATH o %LOCALAPPDATA%/Operant/bin)."""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

HOST = os.path.join(os.path.dirname(__file__), "..", "native-host", "operant_host.py")

# fMP4 mínimo sintético: solo necesita pasar por ffmpeg -c copy. Creamos un
# fMP4 real con ffmpeg si está en PATH; si no, abortamos (el host lo necesita).
FFMPEG = "ffmpeg"


def make_fmp4(path, seconds=0.3, with_audio=True):
    args = [FFMPEG, "-y", "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=128x96:rate=10"]
    if with_audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    args += ["-c:v", "libx264", "-preset", "ultrafast"]
    if with_audio:
        args += ["-c:a", "aac"]
    args += ["-movflags", "+frag_keyframe+empty_moov", path]
    subprocess.run(args, capture_output=True, check=True)


class Host:
    def __init__(self):
        env = dict(os.environ)
        env["OPERANT_BIN"] = os.path.join(tempfile.gettempdir(), "operant-test-bin")
        self.p = subprocess.Popen(
            [sys.executable, HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env,
        )

    def send(self, msg):
        data = json.dumps(msg).encode("utf-8")
        self.p.stdin.write(struct.pack("<I", len(data)) + data)
        self.p.stdin.flush()

    def recv(self, timeout=20):
        deadline = time.time() + timeout
        len_b = b""
        while len(len_b) < 4:
            if time.time() > deadline:
                raise TimeoutError("host sin respuesta")
            chunk = self.p.stdout.read(4 - len(len_b))
            if not chunk:
                raise RuntimeError("host murió")
            len_b += chunk
        (n,) = struct.unpack("<I", len_b)
        raw = b""
        while len(raw) < n:
            chunk = self.p.stdout.read(n - len(raw))
            if not chunk:
                raise RuntimeError("host murió a mitad de mensaje")
            raw += chunk
        return json.loads(raw.decode("utf-8"))

    def wait_for(self, types, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self.recv(timeout=max(1, deadline - time.time()))
            if msg.get("type") in types:
                return msg
            print("  (host):", msg.get("type"))
        raise TimeoutError(f"no llegó ninguno de {types}")


def chunk_file(path, size=600 * 1024):
    with open(path, "rb") as f:
        data = f.read()
    return [data[i:i + size] for i in range(0, len(data), size)]


def main():
    tmp = tempfile.mkdtemp(prefix="rec-test-")
    vpath = os.path.join(tmp, "video.mp4")
    apath = os.path.join(tmp, "audio.mp4")
    make_fmp4(vpath, with_audio=False)
    make_fmp4(apath, with_audio=False, seconds=0.35)
    print("fixtures listos")

    host = Host()
    host.send({"type": "rec-begin"})
    begun = host.wait_for({"rec-beginned"})
    session = begun["session"]
    print("sesión:", session)

    total = 0
    for track, path in (("video", vpath), ("audio", apath)):
        for piece in chunk_file(path):
            host.send({"type": "rec-append", "session": session, "track": track,
                       "data": base64.b64encode(piece).decode("ascii")})
            ack = host.wait_for({"rec-appended", "rec-error"})
            if ack["type"] == "rec-error":
                raise SystemExit("rec-append falló: " + ack.get("message", ""))
            total += ack["bytes"]
    print("bytes enviados:", total)

    host.send({"type": "rec-end", "session": session, "filename": "test-rec e2e"})
    done = host.wait_for({"ffmpeg-done", "rec-error"}, timeout=120)
    if done["type"] == "rec-error":
        raise SystemExit("rec-end falló: " + done.get("message", ""))
    out = done["output"]
    assert os.path.exists(out) and os.path.getsize(out) > 0, "salida vacía"
    print("OK:", out, os.path.getsize(out), "bytes")

    # cancel: sesión inexistente no debe colgar
    host.send({"type": "rec-cancel", "session": "noexiste"})
    host.wait_for({"rec-cancelled"}, timeout=10)
    host.p.terminate()
    print("REC-E2E-OK")


if __name__ == "__main__":
    main()
