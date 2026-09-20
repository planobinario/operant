#!/usr/bin/env bash
# ============================================================
#  Operant - Registro del Native Messaging Host (Linux/macOS)
#  Uso: ./install_host.sh <ID_EXTENSION>
#
#  El ID de la extension se copia desde:
#    chrome://extensions  ->  Modo desarrollador  ->  ID
# ============================================================
set -e

EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
  echo "Uso: $0 <ID_EXTENSION>"
  echo "Abre chrome://extensions, activa 'Modo desarrollador' y copia el ID."
  exit 1
fi

HOST_NAME="com.operant.native_host"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/operant_host.py"

PY=""
for p in python3 python; do
  if command -v "$p" >/dev/null 2>&1; then PY="$p"; break; fi
done
if [ -z "$PY" ]; then
  echo "[ERROR] Python no encontrado. Instala Python 3."
  exit 1
fi

"$PY" - "$HOST_NAME" "$SCRIPT_PATH" "$EXT_ID" <<'PYEOF'
import json
import os
import sys

name, path, ext = sys.argv[1], sys.argv[2], sys.argv[3]
manifest = {
    "name": name,
    "description": "Operant native host (yt-dlp/ffmpeg)",
    "path": path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext}/"],
}
home = os.path.expanduser("~")
targets = [
    f"{home}/.config/google-chrome/NativeMessagingHosts/{name}.json",
    f"{home}/.config/chromium/NativeMessagingHosts/{name}.json",
    f"{home}/.config/microsoft-edge/NativeMessagingHosts/{name}.json",
    f"{home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/{name}.json",
]
for t in targets:
    try:
        os.makedirs(os.path.dirname(t), exist_ok=True)
        with open(t, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        print("written:", t)
    except OSError as exc:
        print("skip:", t, "->", exc)
PYEOF

echo
echo "[OK] Host registrado para Chrome/Chromium/Edge."
echo "Siguientes pasos:"
echo "  1. Reinicia el navegador y recarga la extension."
echo "  2. Abre el panel -> clic en el chip inferior 'Herramientas'."
echo "     El host detecta/descarga automaticamente yt-dlp y ffmpeg a"
echo "     ~/Operant/bin (sin tocar el sistema), con progreso real."
echo "  3. Cuando el chip muestre 'yt-dlp 2026.x ✓', ya puedes usar el boton yt-dlp."
