# Operant — Browser Agent & Media Engine

Extensión multi-navegador (Chrome, Edge, y navegadores Chromium) para **descubrir, extraer y procesar medios y contenido de una página**: imágenes, vídeos, audio, streams HLS/DASH y archivos descargables, con un **panel lateral profesional**, captura de streams por red, **descargas optimizadas con Range requests en paralelo**, **procesado de medios con el ffmpeg nativo del host** (remux, extraer audio, comprimir, redimensionar) e **integración con yt-dlp**, todo vía Native Messaging, diseñado como base modular para agentes de navegación.

> Nota Firefox: el **side panel** (`chrome.sidePanel`) solo existe en Chrome/Edge. En Firefox la extensión sigue funcionando (content script, descargas, host nativo) pero sin el panel lateral.

## Estructura

```
operant/
├── package.json                # Scripts dev (web-ext hot-reload)
├── src/                        # Todo lo que se carga en el navegador
│   ├── manifest.json           # MV3: side_panel, webRequest, downloads, nativeMessaging…
│   ├── background.js           # Service worker: side panel, webRequest (streams), estado por pestaña, host nativo
│   ├── content.js              # Escáner DOM: img/picture/css/lazy, vídeo/audio, embeds, enlaces descargables
│   ├── panel/
│   │   ├── panel.html          # UI del panel lateral (+ diálogo Procesar y Descargas)
│   │   ├── panel.js            # Filtros, grid lazy, descargas por chunks, zip, procesado (host), yt-dlp
│   │   └── panel.css           # Tema oscuro (violeta/cian)
│   ├── vendor/
│   │   └── jszip.min.js        # JSZip bundleado localmente (sin CDN)
│   └── icons/                  # Imán atrayendo medios (16/48/128)
└── native-host/                # Fase 4: app satélite nativa (fuera del sandbox)
    ├── operant_host.py         # Host nativo Python (stdlib, sin pip)
    ├── operant_host.bat        # Wrapper silencioso para Windows
    ├── operant_host_manifest.json # Plantilla para instalación manual
    ├── install_host.bat        # Instalador Windows (Chrome + Edge)
    └── install_host.sh         # Instalador Linux/macOS
```

## Puesta en marcha (desarrollo)

```bash
npm install
npm run dev        # Chromium con hot-reload
npm run dev:firefox
npm run build      # zip instalable en web-ext-artifacts/
```

Carga manual: `chrome://extensions` → Modo desarrollador → **Cargar descomprimida** → carpeta `src/`.

## Verificación funcional real

```bash
npm run test:verify           # 10 casos locales deterministas (sin red)
npm run test:verify:public    # + 5 casos contra sitios públicos reales
```

Lanza Chrome for Testing (descarga automática, ~150 MB) con la extensión cargada, navega a páginas de prueba (galerías con lazy/srcset/picture/background CSS, vídeo, embeds, archivos, SPA, HLS/DASH locales, shadow DOM, 600 imágenes) y a sitios reales (w3schools, python.org, dash.js player…), validando lo detectado por el content script y webRequest. Resultados documentados en **`TESTING.md`** con capturas y logs en `tests/results/`.

> Nota: los Chrome estables ≥ 137 ignoran `--load-extension`; por eso la batería usa Chrome for Testing.

## Qué hace cada módulo

| Módulo | Función |
|---|---|
| `content.js` | Escanea el DOM: `<img>`/`<picture>`/`srcset`, lazy-load (`data-src`, `data-lazy-src`…), `background-image` computado, `<video>`/`<audio>`/`<source>`, embeds (YouTube/Vimeo/Dailymotion/X), `<object>`/`<embed>`, enlaces a archivos (pdf/zip/mp4…). Un `MutationObserver` detecta contenido dinámico (infinite scroll, SPAs) y re-escanea en caliente. |
| `background.js` | Abre el side panel al hacer clic en el icono. **webRequest** observa la red y captura streams que no están en el DOM (`m3u8`, `mpd`, `ts`…). Centraliza el estado por pestaña (con persistencia en `storage.session`) y enriquece cada item con tamaño estimado (HEAD) y dominio. |
| `panel/` | Tabs Imágenes / Vídeos·Audio / Archivos con contadores, **3 vistas (grid/lista/masonry) con slider de thumbnail y ordenación**, buscador, filtros (tamaño mínimo, extensión, dominio), **selección por rango (Shift/Ctrl), criterios rápidos y barra flotante con peso total**, marcado de **posibles duplicados**, descargas por chunks con cola y progreso, zip, **selector de calidad yt-dlp**, procesado con ffmpeg del host, **historial de descargas y exportación de URLs**, toggle auto-detect para SPAs. |
| `native-host/` | Host nativo Python (solo stdlib) que **auto-gestiona yt-dlp y ffmpeg** (detección, descarga, verificación, actualización), ejecuta descargas `yt-dlp -f bestvideo*+bestaudio` y **procesa medios con ffmpeg real** (remux, extraer audio, comprimir, redimensionar) con progreso real y comparación de pesos. |

## Por qué todo el procesado va por el host nativo (y no por WASM)

- **ffmpeg.wasm se descartó a propósito**: duplicaba el ffmpeg del host sin beneficio — más lento (sin aceleración HW), codecs limitados por licencias WASM, ~31 MB extra siempre en la extensión, y dos rutas de código que mantener. Con el host nativo gestionado automáticamente (detección, descarga, actualización), un solo ffmpeg cubre todo: compresión, remux, extracción de audio y conversión.
- **yt-dlp no se puede portar honestamente**: es un conjunto de cientos de extractors por plataforma (firmas, tokens anti-bot) que necesitan forjar cabeceras, usar cookies y saltarse restricciones CORS que el navegador bloquea por diseño. Además depende de ffmpeg nativo para unir streams DASH/HLS. Por eso vive como **módulo opcional vía Native Messaging**, separado del núcleo.

## Permisos del manifest (y por qué)

| Permiso | Para qué |
|---|---|
| `sidePanel` | Panel lateral nativo estilo ImageEye (solo Chrome/Edge). |
| `webRequest` | Observar la red y capturar streams (m3u8/mpd) que no aparecen en el DOM. |
| `downloads` | Descargar archivos individuales y zips (`chrome.downloads`). |
| `storage` | Preferencias (`autoDetect`) y estado por pestaña (`storage.session`). |
| `activeTab` | Acceso puntual a la pestaña al abrir el panel. |
| `nativeMessaging` | Comunicarse con el host nativo yt-dlp/ffmpeg. |
| `host_permissions: <all_urls>` | Que el content script se inyecte en cualquier página y webRequest vea todo el tráfico. |

> **Ojo al distribuir:** `<all_urls>` + `webRequest` disparan el aviso de permisos «Leer y cambiar todos tus datos en todos los sitios web» en la Web Store. Para uso personal no hay problema. Si algún día la publicas, valora reducir a dominios concretos o usar `optional_host_permissions`.

## Fase 4a — Procesado de medios con el ffmpeg del host

Botón **«Procesar»** del panel: eliges un medio detectado en la página y una operación; el host nativo descarga el archivo a tu PC, lo procesa con **ffmpeg real** (rápido, todos los codecs) y guarda el resultado en `~/Downloads/Operant/`, con barra de progreso real (fases download → process) y **comparación de pesos antes/después**.

Operaciones: extraer audio (mp3), remux a mp4 (sin recodificar), convertir a webm, comprimir (h264+aac con CRF configurable), reescalar al 50 %, imagen → jpg/webp. Requiere ffmpeg instalado (el host lo instala solo: Panel → Herramientas).

## Fase 4b — yt-dlp vía Native Messaging (opcional)

### Auto-gestión de yt-dlp y ffmpeg (sin instalación manual del usuario)

El host nativo **detecta, descarga, verifica y actualiza** las herramientas por sí mismo. La extensión nunca descarga ni ejecuta binarios (sandbox): solo pide al host vía Native Messaging, y el host hace el trabajo fuera del navegador con permisos de SO.

- **Detección** (orden): carpeta propia `~/Operant/bin/` (Windows: `%LOCALAPPDATA%\Operant\bin\`) → PATH del sistema (`--version` / `-version` reales). El chip inferior del panel muestra el estado.
- **Descarga automática**: si falta yt-dlp/ffmpeg, el panel muestra «Instalar» con barra de progreso real (porcentaje + fase: download → extract → verify).
  - yt-dlp: binario único de GitHub Releases (yt-dlp.exe en Windows).
  - ffmpeg: build estático oficial — gyan.dev en Windows; BtbN (Linux/macOS, tar.xz/zip).
  - Instala en `~/Operant/bin/` **sin tocar instalaciones del sistema** (si el usuario ya tiene yt-dlp/ffmpeg para otros usos, la extensión usa los suyos).
  - Verificación funcional post-descarga (el binario responde `--version`) y reemplazo **atómico** (descarga a temporal → verifica → `os.replace`; nunca queda el sistema a medias).
- **Actualizaciones**: compara la versión local contra la última de GitHub (yt-dlp; vía el redirect de `releases/latest/download`, **sin golpear la API** — no hay rate-limits). Cache de 24 h. ffmpeg no versiona de forma estable: ofrece «Reinstalar» (builds diarios).
- El chip del panel abre el diálogo **Herramientas**: estado por herramienta (instalado vX (app/sistema) · no instalado · actualización disponible), botones contextuales Instalar/Actualizar/Reinstalar, y aviso de que la primera instalación de ffmpeg descarga ~100 MB (con progreso, no un spinner ciego).

> El host en sí requiere instalación manual **una sola vez** (`install_host.bat <ID>` / `.sh <ID>`): es la única parte que no se puede automatizar por el modelo de seguridad del navegador.

#### Endpoints externos usados por el host (para listas de permisos de red, si las hay)

| Recurso | URL | Uso |
|---|---|---|
| yt-dlp binario | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp` (y `-exe` en Windows) | descarga e instalación (redirect a `objects.githubusercontent.com`) |
| Versión de yt-dlp | mismo enlace, capturando el `Location` del redirect (`/releases/download/<versión>/`) | check de actualizaciones (sin API, cache 24 h) |
| ffmpeg Windows | `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip` | build estático esencial |
| ffmpeg Linux | `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz` | build estático |
| ffmpeg macOS | `.../ffmpeg-master-latest-macosarm64-gpl.zip` (o `macos64`) | build estático |

Requisitos previos del host: Python 3 en el PATH (el propio host corre con la stdlib).

### Registro del host (una sola vez)

El navegador no permite ejecutar procesos desde el sandbox de una extensión. La única vía es un **Native Messaging Host**: un script local que la extensión invoca. No se puede automatizar por políticas de seguridad — el usuario lo instala una vez:

1. Copia el **ID de la extensión**: `chrome://extensions` → Modo desarrollador → ID (32 caracteres).
2. Ejecuta el instalador desde `native-host/`:
   - **Windows:** `install_host.bat <ID_EXTENSION>`
   - **Linux/macOS:** `./install_host.sh <ID_EXTENSION>`
3. Cierra y reabre el navegador, recarga la extensión.
4. Abre el panel → clic en el chip inferior → **Herramientas**: el host detecta/instala yt-dlp y ffmpeg automáticamente.

Instalación manual (alternativa a los scripts): copia `operant_host_manifest.json` a la ruta correcta con el `path` absoluto del `.py` y tu ID en `allowed_origins`, y registra la clave de registro / archivo de manifest según el sistema:

- Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.operant.native_host` → ruta al JSON
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.operant.native_host.json`
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.operant.native_host.json`

Las descargas de medios con el botón «yt-dlp» escriben en `~/Downloads/Operant/` con la **máxima calidad** (`bestvideo*+bestaudio`, unido a mp4) y muestran el progreso por ciento en la barra de estado del panel.

## Botones de acción rápida por tipo de contenido

Cada card del panel muestra, al pasar el ratón (hover), los botones de acción según el tipo de contenido, en la esquina superior izquierda (separados ~10 px del borde, con transición suave de aparición):

| Tipo | Botones |
|---|---|
| Imagen estática | «Descargar en alta calidad» (intenta la mayor resolución real: quita parámetros de resize tipo `?w=300` o usa el candidato mayor del srcset) |
| GIF | «Descargar GIF» + «Descargar frame actual» (captura el frame visible con `<canvas>`) |
| Vídeo | «Descargar vídeo» (usa la jerarquía: directo → stream → manifiesto parseado → yt-dlp) + «Descargar frame actual» (frame exacto del preview) |
| Audio | «Descargar audio» |
| Archivo (pdf/zip/docx…) | «Descargar archivo» |

### Interacción de descarga (preferencia configurable)

El prompt original pedía descargar con solo pasar el hover, pero eso genera **descargas accidentales** (el ratón cruza botones constantemente). Ningún producto serio (ImageEye/FetchV) descarga en hover: lo usan para *revelar*. La extensión ofrece **dos modos**, seleccionables en el panel → «Descargas»:

- **`click` (por defecto, recomendado)**: el hover revela los botones y el click ejecuta la acción. Patrón estándar.
- **`hover sostenido`**: si el ratón permanece ~700 ms sobre el botón específico (no la card), se dispara la descarga, con un **anillo de progreso circular** durante esos 700 ms para que el usuario vea que está a punto de dispararse y pueda retirar el ratón si fue accidental. Retirarlo antes de completar el anillo cancela la descarga.

Cada acción muestra un toast breve de confirmación.

## Notas técnicas

- **Descargas por chunks:** el botón «Descargar» usa Range requests en paralelo (4 MB/chunk, tope de 8 fetches simultáneos, cola configurable de 1-8 jobs) cuando el servidor las soporta; fallback a descarga simple si no. El diálogo «Descargas» muestra progreso por archivo y agregado. Los archivos se ensamblan en memoria (tope práctico ~1-2 GB).
- **webRequest y blob:** las URLs `blob:` no pasan por webRequest (no son accesibles desde el sandbox). Se intentan descargar vía fetch; si fallan, el panel lo indica.
- **Streams (m3u8/mpd):** el botón de descarga intenta bajar el índice; para unir segmentos en mp4 usa el botón **yt-dlp** (requiere Fase 4b).
- `npx web-ext lint` → 0 errores. Los 4 warnings son esperados:
  - `sidePanel` (permission + `setPanelBehavior`): API de Chrome/Edge, Firefox no la tiene.
  - `service_worker`: falso positivo conocido del linter; el manifest usa el patrón dual recomendado por MDN (`scripts` + `service_worker`).
  - `DANGEROUS_EVAL` en `jszip.min.js`: wrapper UMD de la librería, estándar y seguro.
- **Peso:** la extensión es ligera (~250 KB + JSZip); ffmpeg/yt-dlp viven en el host nativo, no en la extensión.
- El service worker de MV3 puede dormir: todo el estado se guarda en `chrome.storage.session`.
- Consolas: service worker en `chrome://extensions` → «Vista de service worker»; panel: clic derecho → «Inspeccionar».
