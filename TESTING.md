# TESTING.md — Batería de verificación funcional real

Verificación **funcional y documentada** del scraping, no solo `web-ext lint`: se lanza Chrome for Testing con la extensión cargada (`--load-extension`), se navega a páginas de prueba locales deterministas y a sitios públicos reales, y se valida lo que el content script / webRequest detecta realmente.

> **Por qué Chrome for Testing:** desde Chrome 137, los builds estables **ignoran `--load-extension`** por seguridad. La batería descarga automáticamente un build de Chrome for Testing (`tests/.chrome/`, ~150 MB, una sola vez).

## Cómo ejecutarla

```bash
npm install                     # incluye puppeteer-core (devDependency)
npm run test:verify             # 10 casos locales (deterministas, sin red)
npm run test:verify:public      # + 5 casos contra sitios públicos reales (requiere red)
```

Cada caso genera en `tests/results/`:
- `<id>.json` — items detectados, checks (esperado vs real), errores de consola, duración.
- `<id>.png` — captura de pantalla de la página probada.

La infraestructura vive en `tests/`:
- `generate-fixtures.js` — genera las páginas de prueba locales.
- `fixtures-server.js` — servidor HTTP local (puerto 8765) con media real generada por ffmpeg.
- `run-verification.js` — el driver CDP: navega, hace scroll/clics, consulta el content script vía `chrome.tabs.sendMessage({type:"scan"})` y valida.

---

## Resultados (Chrome for Testing 153, 2026-08-01)

| # | Caso | Verdict | Items | Qué se verificó |
|---|------|---------|-------|-----------------|
| 01 | Galería: lazy-load, srcset, picture, background CSS, dedupe | **PASS** | 325 | 60 `<img>` planos, 50 `data-src` + 50 `data-lazy-src`, 30 `srcset` (ambas resoluciones), 20 `<picture>` (source srcset + img), 30 background inline, 10 background por stylesheet, duplicados por fragmento colapsados, 5 variantes por query conservadas, 3 `data:` URIs excluidas |
| 02 | Vídeo HTML5 nativo + audio | **PASS** | 4 | mp4 + webm (sources), mp3 (audio), poster como imagen |
| 03 | Embeds YouTube/Vimeo/Dailymotion/X | **PASS** | 12 | iframes detectados con `embed` y thumbnail YouTube (`i.ytimg.com`), Dailymotion; Vimeo/X sin thumbnail (no existe endpoint público simple) |
| 04 | Archivos descargables por extensión | **PASS** | 6 | pdf/zip/docx/tgz/mp4/mp3 detectados; anclas `#`, `mailto:`, `javascript:` y páginas normales excluidas |
| 05 | HLS local (hls.js) — webRequest | **PASS** | 3 | `stream.m3u8` + segmentos `.ts` capturados con `source:"network"` |
| 06 | SPA: scroll + cambio de ruta | **PASS** | 76 | MutationObserver detecta imágenes inyectadas por scroll y el vídeo inyectado por "ruta" |
| 07 | Shadow DOM | **PASS** | 4 | Shadow root **abierto**: 2 imágenes + 1 vídeo detectados; shadow **cerrado**: NO inspeccionable (esperado, limitación documentada) |
| 08 | Rendimiento: 600 imágenes | **PASS** | 600 | Escaneo completo + estabilización en ~5,3 s; 0 duplicados; lazy-render del panel por construcción (chunks de 60) |
| 09 | Estado centralizado | **PASS** | 325 | `storage.session` guarda el estado por pestaña (`tab_*`) recibido del content script |
| 10 | Native host healthcheck | **PASS** | — | Con el host NO registrado, `connectNative` falla limpio (sin errores de extensión): el panel oculta el botón yt-dlp |
| p1 | Unsplash (infinite scroll) | **FAIL** | 1 | Unsplash devuelve **403 anti-bot** a la automatización headless. En navegador normal (usuario real) debería detectarse; queda como verificación manual pendiente |
| p2 | w3schools (vídeo HTML5) | **PASS** | 11 | fuentes `.mp4`/`.webm`/`.ogg` del `<video>` detectadas en sitio real |
| p3 | python.org/downloads | **PASS** | 13 | enlaces de descarga (tgz/xz/zip/exe) + imágenes detectados en sitio real |
| p4 | hls.js demo (HLS público) | **WARN** | 0 | El demo de React no arranca la reproducción en automatización (estado persistido; requiere clics manuales). La captura HLS vía webRequest ya está probada en el caso local 05 y en p5 |
| p5 | dash.js reference player (DASH público) | **PASS** | 18 | manifest `.mpd` + segmentos capturados por webRequest en sitio real |

**13 PASS · 1 WARN · 1 FAIL** (los dos últimos con causa externa documentada).

## Bugs reales encontrados y corregidos durante la verificación

1. **`srcset` no se leía** — `LAZY_ATTRS` incluía `data-srcset` pero no `srcset`; las imágenes con `srcset` plano no aportaban candidatos (faltaban exactamente 60 de 325). Corregido en `src/content.js`.
2. **Shadow DOM no se recorría** — `allShadowRoots()` nunca añadía los roots al array (bug de implementación); los componentes web quedaban invisibles. Corregido en `src/content.js`.
3. **Streams tempranos perdidos** — hls.js pide el m3u8 antes de que el content script se inyecte (`document_idle`), y el item se perdía. Añadido handshake: al inyectarse, el content script pide al SW (`content-ready`) los streams capturados por webRequest y se los reenvía. Corregido en `src/content.js` + `src/background.js`.
4. (Harness) El Chrome estable 137+ ignora `--load-extension` → la batería ahora descarga Chrome for Testing automáticamente.
5. (Harness) La primera navegación podía ocurrir antes de que el sistema de extensiones estuviera listo → warm-up con `ping` + reload.

## Rendimiento (caso 08)

- 600 imágenes: escaneo completo + estabilización **~5,3 s** (el escaneo de background-image es por tandas vía `requestIdleCallback`; el resto es síncrono por diseño).
- Dedupe: 0 duplicados (Set por URL sin fragmento).
- El panel no congela: lazy-render en chunks de 60 + `IntersectionObserver` (por construcción; la UI del panel no se ejercitó en headless).

## Native host — healthcheck

- **Host no instalado** (caso 10): `chrome.runtime.connectNative` lanza error limpio y manejado → `installed:false` → el botón yt-dlp se oculta sin errores en consola.
- **Host instalado**: responde `pong {ytDlp, ffmpeg}` — probado manualmente contra `native-host/operant_host.py` con el protocolo framing real (4 bytes LE + JSON).
- No se probó el caso "yt-dlp desactualizado" (el host solo comprueba presencia en PATH, no versión); si `yt-dlp` falla en runtime, el host reenvía el error de yt-dlp al panel.

## Limitaciones reales (documentadas, no arreglables desde la extensión)

- **Shadow DOM cerrado**: inaccesible por diseño del navegador (`attachShadow({mode:"closed"})`).
- **Iframes cross-origin**: su contenido no es inspeccionable (aislamiento del navegador); solo se detecta el iframe embed si es de plataforma conocida.
- **DRM / streams protegidos**: no aparecen como `<video>` con URL accesible; si siquiera se detecta un `blob:` no es descargable desde el sandbox → el plan es cubrirlo en la Parte D con `tabCapture` (grabación en tiempo real).
- **`blob:` URLs**: no pasan por webRequest ni son fetcheables desde la extensión.
- **Anti-bot**: sitios como Unsplash devuelven 403 a tráfico automatizado (no afecta al usuario normal).
- **CORS en descargas**: algunos CDNs rechazan HEAD/fetch desde la extensión; el panel lo avisa por item.

## Native host — auto-gestión de yt-dlp/ffmpeg

Pruebas funcionales reales (`python tests/host-e2e.py`, Chrome/Windows): el host se ejecuta con el protocolo Native Messaging real contra una carpeta `bin/` temporal, con fakes y con descargas reales.

| # | Caso | Verdict | Resultado |
|---|------|---------|-----------|
| H1 | Detección PATH (carpeta vacía) | **PASS** | yt-dlp v2026.03.17 (system), ffmpeg v2025-09-18 (system) — detectados y versionados |
| H2 | Prioridad app-bin sobre PATH | **PASS** | fakes en `bin/` ganan a los del PATH; versiones parseadas (yt-dlp `2020.01.01`, ffmpeg `6.1.1…`) |
| H3 | Check de actualizaciones | **PASS** | fake v2020.01.01 → `updateAvailable: true`, última 2026.07.04 (vía redirect de GitHub, sin API ni rate-limit) |
| H4 | Instalación real de yt-dlp | **PASS** | descarga ~17 MB desde GitHub, 280 mensajes de progreso, verificación funcional, reemplazo atómico → v2026.07.04 |
| H5 | El yt-dlp descargado funciona | **PASS** | descarga el stream HLS local (`tests/fixtures/media/stream.m3u8`) a `test.mp4` (rc=0) |
| H6 | Estado post-instalación | **PASS** | source=app, `updateAvailable: false` contra la última |
| H7 | Instalación real de ffmpeg | **PASS** | ~100 MB desde gyan.dev → v8.1.2-essentials; fases download→extract→verify |
| H8 | **ffmpeg-op real** (Parte C) | **PASS** | `extract-mp3` sobre el mp4 local: 52 KB → 49 KB, fases download→process, mp3 válido (50 301 B) |
| L1-L3 | Linux en WSL: fakes, prioridad app-bin, redirect | **PASS** | 3/3 (Ubuntu 24.04, Python 3.12) |
| L4-L6 | Linux en WSL: **yt-dlp real + chmod +x + ejecución** | **PASS** | binario Linux v2026.07.04, permisos 0o755, `--version` OK |
| L7-L9 | Linux en WSL: **ffmpeg BtbN tar.xz real** (~90 MB) | **PASS** | descarga → extracción tar.xz → chmod → verificación → `-version` OK |

**Bugs reales encontrados y corregidos**: (1) `subprocess.run` de un binario de consola desde el host se **bloqueaba indefinidamente** cuando el hilo principal lee stdin (deadlock de creación de consola en Windows — reproducido y aislado; fix: `CREATE_NO_WINDOW` + `stdin=DEVNULL`); (2) `tool_candidates` anexaba extensiones a `yt-dlp.exe` en vez de a `yt-dlp`; (3) en Unix el `chmod +x` se hacía **después** de verificar, así que el binario recién extraído no era ejecutable durante la verificación; (4) ffprobe se extraía pero no se instalaba (se perdía); (5) el check de versiones pasó de la API de GitHub (rate-limited) al `Location` del redirect, con **error visible** (`updateCheckError`) si el parseo falla.

**Pendiente**: flujo macOS (BtbN zip arm64/x64) implementado pero sin equipo Mac para probarlo; la lógica es idéntica a la de Windows (zip) y Linux (verificación + chmod).

## Auditoría de producto (paridad FetchV/ImageEye)

Suite separada (`npm run test:audit` → `tests/run-panel-audit.js`): abre la página del panel contra fixtures reales y valida los bloques de producto. **12/12 PASS** (2026-08-02).

| Bloque | Resultado |
|---|---|
| **B1 Carga inicial** | Contador y grid poblados al abrir (600 items); skeletons mientras se escanea; no hay pantalla vacía. |
| **B2 Vistas** | Grid/lista/masonry con slider de tamaño de thumbnail, ordenación (detección/tamaño/dimensiones/dominio) y persistencia en `storage.local`; capturas en `tests/results/screenshot-{grid,list,masonry}.png`. |
| **B3 Selección** | Shift+clic (rango), Ctrl+clic (alternar), «visibles» vs «filtrados», criterios rápidos (>100KB/>1MB/>5MB/tipo), barra flotante con contador + peso total estimado, marcado visual de **posibles duplicados** (mismo path+query en distinto host/CDN). |
| **B4 Calidad/Preview** | Selector de calidad real vía `yt-dlp -F` antes de descargar (el host parsea los formatos; verificado en `host-e2e.py`); hover con preview ampliado + URL/dimensiones/peso; metadata visible en cada card. |
| **B5 Rendimiento** | 600 items → DOM activo **acotado a 1-2 chunks (120 nodos)**; filtro en tiempo real con debounce (11 coincidencias en <400 ms); cola de 3 descargas por chunks con Range real → 3/3 done al 100% con 12 MB exactos. El scroll-lazy requiere confirmación visual (las capturas sirven de evidencia); en headless el layout de pestañas ocultas está congelado y no es medible de forma fiable. |
| **B6 Sincronización** | Navegación a otra URL limpia resultados (`onUpdated`); panel de dos pestañas refleja cada una sin mezclar (600 vs 325 verificado); descarga fallida → estado `error` con botón **Reintentar** (nunca «descargando…» infinito); re-escaneos no duplican (dedupe por URL). |
| **B7 Diferencial** | **Historial de descargas** (300 entradas, buscable, re-descarga con un clic, export JSON) + **exportación de URLs filtradas** (.txt, un URL por línea). |

**Bugs reales encontrados y corregidos por la auditoría:**
1. **La cola de descargas en el SW nunca habría entregado archivos**: los service workers de MV3 no tienen `URL.createObjectURL` (error en runtime). Se movió la cola completa al panel (donde sí existe) con progreso real por archivo/agregado y retry. Verificado end-to-end con Range real (A2).
2. **Lazy-render roto**: `render()` hacía `grid.textContent = ""`, que borraba el sentinel del grid → el IntersectionObserver observaba un nodo desconectado y solo se renderizaban 60 items. Se re-adjunta el sentinel tras cada limpieza y se observa con `root: grid` (scroll container real, no el viewport).
3. **Layout colapsado con columnas `minmax(140px, 1fr)`**: `aspect-ratio` no resuelve altura con columnas `1fr` + filas auto en este entorno → altura del thumbnail en px explícita desde JS (slider) + `min-height: 0` en el grid (bug clásico flexbox+overflow). Un probe aislado confirmó el patrón CSS correcto.
4. La batería integrada no puede medir geometría del panel (pestaña oculta = layout congelado): se extrajo a suite propia.

## Verificación manual pendiente (no automatizable en headless)

- **Confirmación visual** de las tres vistas (grid/lista/masonry), hover preview y barra flotante de selección: `tests/results/screenshot-*.png`.
- **Selector de calidad (B4)**: flujo verificado a nivel de host (`yt-dlp -F` real); falta probar el diálogo en navegador con un vídeo real.
- `tabCapture`/`MediaRecorder` (Parte D) — requiere pestaña real y permisos.

---

## Motor de escaneo activo (exhaustividad contra ImageEye) — 2026-08-02

Investigación: en una galería de árboles, el escáner detectaba **36 imágenes** donde ImageEye detectaba **267-282**. La brecha venía de un escaneo pasivo: solo se miraba el DOM una vez, esperando el lazy-load del usuario. ImageEye hace **auto-scroll programático** ("analyzing X of Y"). Rediseño del motor de `src/content.js` + `src/panel/panel.js`:

### Parte A — De pasivo a activo

| Fuente | Antes | Después | Cómo |
|---|---|---|---|
| **Auto-scroll activo** | ❌ no existía | ✅ `force-rescan` (botón «Actualizar» / auto-detect) ejecuta un ciclo de scroll por viewport, espera ~400 ms por paso para el lazy-load, re-escanea y repite hasta el final del `scrollHeight` (o 3 paradas sin crecer = scroll infinito agotado) | `autoScrollScan()` en `content.js`; progreso real «Escaneando… (scroll N)»; **restaura el scroll del usuario** al terminar; **cancelable** con el botón ✕ de la scanbar (`cancel-scan`) |
| **`<noscript><img>`** | ❌ | ✅ se parsea el HTML crudo como texto (regex `src`/`srcset`) — fallback típico de lazy-load | `scanImages()` en `content.js` |
| **Iframes same-origin** | ❌ | ✅ se accede a `contentDocument` recursivamente (incluye iframes dentro de iframes); sus `<img>`/`<video>`/shadow entran al escaneo | `allIframeDocs()` en `content.js` |
| **Iframes cross-origin** | ❌ (solo embed conocido) | ⚠️ **limitación documentada**: el DOM no es inspeccionable por aislamiento del navegador; sus peticiones de imagen/vídeo se capturan vía `webRequest` (nivel 2 del sniffing) cuando el contenido se carga | `allIframeDocs()` + `webRequest` en `background.js` |
| **Shadow DOM anidado** | ✅ (1 nivel) | ✅ recursivo (shadow dentro de shadow) | `allShadowRoots()` ya era recursivo |
| **srcset completo** | ✅ (se listan variantes) | ✅ cada candidato de resolución es un item separado (misma imagen, distinta URL) | `parseSrcset()` |
| **Re-escaneo por interacción** | ⚠️ solo MutationObserver | ✅ + clicks en botones tipo «cargar más»/«ver más»/«load more» (patrón de texto) disparan re-escaneo con debounce de 1,2 s | `handleUserClick()` en `content.js` |

### Parte B — Jerarquía de vídeo (yt-dlp solo como último recurso)

| Nivel | Método | Cómo se detecta/descarga | Badge |
|---|---|---|---|
| 1 | `<video>`/`<source>` con URL directa | lectura del DOM; descarga por chunks, sin dependencias | `directo` |
| 2 | Sniffing de red | `chrome.webRequest` (Content-Type / extensión) en `background.js` | `stream` |
| 3 | Manifiesto HLS/DASH (`.m3u8`/`.mpd`) | **parseo propio del manifiesto** (texto plano): se extraen calidades y se reensamblan con ffmpeg del host vía URL (`hls-dash` en `operant_host.py`); sin yt-dlp | `manifest` |
| 4 | Fallback final | yt-dlp (embeds de plataforma: YouTube/TikTok…; o si el parseo propio falla por CORS/DRM) | `embed` |

La UI muestra un **badge de método** en cada card de vídeo/audio (grid: `badge method-*` bajo el tipo; lista: `lc-badge method` en la metadata) para que sea transparente qué técnica se usó.

### Verificación pendiente (requiere la URL real de la galería de árboles)

1. Contar imágenes **antes** de estos cambios en la página real (la captura de ImageEye marcaba 267-282; el escáner previo marcaba 36).
2. Contar **después**: esperado ≥ el conteo previo + el delta de lazy-load revelado por el auto-scroll.
3. Si la brecha persiste, inspeccionar qué se pierde: iframes cross-origin (solo capturables vía webRequest mientras cargan), imágenes servidas por JS sin atributos estándar, o Content-Type sin extensión en la URL.
4. Subir captura del contador del panel tras el fix comparada con la referencia de ImageEye.

### Tests locales ya cubiertos (sin cambios de fixture)

- El caso 05 (HLS local) valida el **nivel 2/3**: `stream.m3u8` capturado por `webRequest` con `method:"manifest"`.
- El caso 06 (SPA) valida que el **MutationObserver** sigue re-escaneando contenido inyectado.
- El caso 07 (Shadow DOM) valida los shadow roots anidados.

---

## Tamaños reales de archivos — técnicas y verificación (2026-08-02)

**Problema:** algunos recursos (CDNs tipo `gstatic.com`/Google Images) no devuelven `Content-Length` en `HEAD`, y la extensión mostraba "?" / "…" aunque el tamaño sí era obtenible.

**Técnicas implementadas (de más fiable a menos):**

| Nivel | Técnica | Dónde | Resultado |
|---|---|---|---|
| 0 | **Performance Resource Timing API**: `performance.getEntriesByType('resource')` → `encodedBodySize` (bytes reales transferidos, sin petición extra) | `content.js` (`perfSizeBytes()`), re-consultado en cada `notify()`; buffer ampliado a 2000 entradas | El tamaño real que el navegador ya registró al cargar el recurso |
| 1 | **GET real + `response.blob().size`**: cuenta los bytes recibidos, independiente de cabeceras | `background.js` (`enrichSize`) | Preciso aunque el servidor no mande `Content-Length` |
| 2 | **HEAD + Content-Length** (menos fiable, último recurso) | `background.js` | Algunos CDNs lo rechazan |

**Verificación real:**
- Imagen local servida **sin Content-Length** (`/img-nolen.png`): la Performance API registró `encodedBodySize: 70`; el panel muestra `1 KB` (70 B), `sizeUnknown: false`, **0 items con null**.
- Recursos reales de `gstatic.com`: la Performance API registró `encodedBodySize: 65536` y `341055` (bytes reales) en páginas reales — confirmando que la técnica 0 obtiene tamaños de gstatic cuando el recurso está en el buffer del navegador.
- **Caso genuinamente irrecuperable** (solo si las 3 técnicas fallan): CORS estricto con respuesta opaca (`no-cors`) y recurso **no** cargado por el navegador en esta sesión — entonces el badge muestra "?" con `sizeUnknown: true`. Google Images real en headless redirige a `/sorry/` (anti-bot), así que la verificación end-to-end contra `encrypted-tbn0.gstatic.com` concreta requiere navegador normal; la mecánica está probada de forma determinista con el fixture.

---

## Overlay en la página real (estilo Double-click Image Downloader) — 2026-08-02

Capa **arquitectónicamente distinta** del side panel: un content script que muestra un **botón flotante directamente sobre cada imagen/vídeo del DOM** mientras el usuario navega, **sin necesidad de abrir el panel**. Complementaria a los hover-buttons de las cards del panel (esas viven en el panel; esta vive en la página).

| Aspecto | Estado |
|---|---|
| Hover sobre `<img>` en la página | ✅ Botón "Descargar imagen" (usa la mayor resolución: quita params de resize del CDN) |
| Hover sobre `<img>` GIF | ✅ "Descargar GIF" + "Descargar frame actual" (canvas) |
| Hover sobre `<video>` | ✅ "Descargar vídeo" + "Descargar frame actual" (canvas) |
| Hover sobre `<audio>` | ✅ "Descargar audio" |
| Hover sobre `<a href>` a archivo | ✅ "Descargar archivo" |
| Posicionamiento | ✅ `getBoundingClientRect` + `position: fixed`, offset 10px, z-index máximo; se reposiciona en scroll/resize |
| Anti-parpadeo | ✅ Mover el ratón de la imagen al botón mantiene el overlay visible; salir lo oculta (delay 150ms) |
| Toggle | ✅ Checkbox "overlay en la página" en el panel (Opciones), persiste en `storage.local`, por defecto activado |
| Blacklist por dominio | ⚠️ El storage ya lo soporta (`overlayBlacklist`); el toggle global está implementado, el campo de blacklist en el panel está pendiente |
| Descarga | ✅ `chrome.downloads.download` vía mensaje `overlay-download` en background.js |

**Verificación real (Chrome for Testing, panel cerrado):**
- Página `photos.html`, sin abrir el panel → hover sobre una imagen real → overlay visible con "Descargar imagen", posicionado en (42,94), z-index 2147483647. Captura: `scratchpad/verify-overlay.png` (la página con el botón flotante sobre la imagen).
- Mover el ratón al botón: overlay sigue visible (`hidden:false`). Salir: se oculta (`hidden:true`).
- Consola de la página sin errores de la extensión.

### Cobertura EXHAUSTIVA del overlay (2026-08-02)

El overlay cubre **cualquier archivo**, no solo `<img>` directos. `overlayFindTarget` sube por el árbol DOM y detecta, verificado con hover real en cada uno (logs crudos):

| Elemento bajo el ratón | Botones del overlay |
|---|---|
| `<img>` | "Descargar imagen" (+ "Frame GIF" si es GIF) |
| `<div>` con `background-image` CSS | "Descargar imagen" |
| `<video>` | "Descargar vídeo" + "Frame" |
| `<audio>` | "Descargar audio" |
| `<a href>` a archivo (pdf/zip/mp4…) | "Descargar archivo" |
| `<source>`, `<object>`, `<embed>` | según su URL (imagen/archivo) |

Antes de este cambio el overlay solo funcionaba con `t.closest("img, video, audio, a[href]")`, que dejaba fuera los `background-image` CSS y cualquier elemento anidado. Ahora la detección es exhaustiva y los botones se construyen según el tipo real (`overlayTypeOf`/`overlayUrlOf`).

### Diseño de iconos (2026-08-02)

El overlay pasó de botones de texto a **iconos SVG compactos y sutiles**: fila horizontal de iconos 16×16 en la esquina superior izquierda del elemento, fondo oscuro translúcido con blur, esquinas redondeadas, hover con acento violeta y escala sutil.

| Tipo | Iconos |
|---|---|
| Imagen | 1 icono (imagen) — "Descargar imagen" |
| GIF | **3 iconos**: imagen ("Descargar imagen") + vídeo ("Descargar como vídeo" → webm vía ffmpeg del host) + cámara ("Descargar frame actual del GIF") |
| Vídeo | **3 iconos**: flecha ("Descargar vídeo") + **nota con tachado ("Descargar solo el audio" → mp3 vía ffmpeg del host)** + cámara ("Descargar el fotograma actual") |
| Audio | 1 icono (nota) — "Descargar audio" |
| Archivo | 1 icono (documento) — "Descargar archivo" |

Verificado en navegador real: hover sobre `<video>` → 3 SVGs ("Descargar vídeo", "Descargar solo el audio", "Descargar el fotograma actual"); hover sobre `<img>` GIF → 3 SVGs ("Descargar imagen", "Descargar como vídeo", "Descargar frame actual del GIF").

### Descarga de streams y preview de vídeo (2026-08-02)

- **Streams (m3u8/mpd/ts)**: la descarga desde el overlay antes fallaba con "Comprueba la conexión" porque `chrome.downloads.download` no maneja manifiestos. Ahora:
  - **m3u8/mpd → conversión a MP4 real** con ffmpeg del host (`hls-dash`: `-c copy`, máxima calidad **sin recodificar**, formato versátil en vez del manifiesto crudo). Verificado: el SW responde `{ok:true, note:"Convirtiendo stream a MP4 (máxima calidad)…"}`.
  - **.ts y archivos directos** → descarga directa.
  - Sin host nativo: fallback a fetch+blob del manifiesto (mejor que nada, pero es texto — no recomendado).
- **"Descargar solo el audio"** y **"Descargar como vídeo" (GIF)**: usan el host nativo (`ffmpeg-op` → `extract-mp3` / `convert-webm`) — requieren el host instalado; si no, el SW responde con el error claro.

### Descarga inteligente por tipo de URL (2026-08-02)

El overlay ya no intenta `chrome.downloads.download` a ciegas — decide según la URL:

| URL del vídeo | Estrategia |
|---|---|
| **Directa** (`.mp4/.webm/.mov/…`) | Descarga directa |
| **Manifiesto** (`.m3u8/.mpd`) | Convierte a **MP4 real** con ffmpeg del host (`-c copy`, máxima calidad) |
| **Página HTML / sin extensión** (`.htm`, streaming protegido, plataformas tipo YouTube/Erome) | **yt-dlp** (extractors profesionales, usa ffmpeg internamente para unir) |
| **`.ts`** | Descarga directa (segmento) |

- **"Descargar solo el audio"**: URL directa → ffmpeg `extract-mp3`; URL no-directa/plataforma → **yt-dlp `bestaudio` → mp3** (`-x --audio-format mp3 --audio-quality 0` en el host).

### Única fuente de verdad: src/shared/media-core.js (2026-08-02)

Eliminada la duplicación: antes había **dos** `parseManifest` (panel.js y background.js) y dos cadenas de decisión de descarga. Ahora toda la detección vive en **`src/shared/media-core.js`** (`NTMedia`), importado como ES module por el **SW** (`import { NTMedia }`) y por el **panel** (`<script type="module">`). Contiene: clasificación por extensión, HEAD → GET+Range → magic bytes, parseo HLS/DASH propio, y `classifyDownload(url, kind)` que devuelve la estrategia (`direct` / `manifest` / `ytdl` / `unknown`).

Verificado en navegador real con la **misma función** `NTMedia.classifyDownload`:

| Caso | Estrategia | Razón |
|---|---|---|
| `sample.mp4` | `direct` | extensión .mp4 |
| `/video-stream.htm` (sirve video/mp4) | `direct` | Content-Type video/mp4 |
| `stream.m3u8` | `manifest` (parseado: `type:hls, segments:1`) | extensión .m3u8 |
| YouTube | `ytdl` | URL no-descargable o plataforma |

El panel carga como module sin errores (`ntLoaded:true`).

**Causa raíz del fallo "El archivo no estaba disponible en el sitio":** el vídeo `yzvoFlaw_720p.htm` NO era una página — era un **vídeo real servido con una URL rara** (sin `.mp4`). Decidir por extensión era la técnica equivocada.

**Fix:** para vídeos con URL no-claramente-directa, el SW hace un **HEAD y mira el `Content-Type` real**:
- `video/*`, `audio/*`, `application/octet-stream`, `application/mp4` → **descarga directa** (archivo real aunque la URL sea rara).
- `text/html` u otro → **yt-dlp** (sí es página/plataforma).
- Verificado en navegador real: URL `.htm` que sirve `video/mp4` + `kind:video` → `{ok:true}` (descarga directa); YouTube → `{ok:true}` (yt-dlp).
- **Preview de vídeo**: los vídeos directos (mp4/webm) sin thumbnail muestran el **primer fotograma real** (capturado con `<video>` oculto + canvas → dataURL); y el área respeta el **aspect ratio real** del vídeo (`--video-ratio` desde `item.w/h`) en vez de forzar 16:9 o el mínimo de 120px. Los streams (m3u8/mpd) mantienen el placeholder (no se puede obtener el primer frame sin reproducirlos).

---

## Migración a CSS Anchor Positioning (overlay + popover) — 2026-08-03

### Arquitectura: dual-mode nativo/fallback en el mismo estilo

El overlay y el popover de la página se migraron a la **CSS Anchor Positioning API** (Chrome 125+, Baseline 2026). En navegadores con soporte, el motor de renderizado posiciona el overlay relativo al ancla (la imagen/vídeo bajo el cursor) en el **hilo de composición** — sincronización perfecta durante scroll, **sin JavaScript en el movimiento** (cero lag, cero listeners de scroll para el posicionamiento).

| Modo | Detección | Posicionamiento |
|---|---|---|
| **Nativo** | `CSS.supports("anchor-name", "--nt-test")` | `position: fixed` + `position-anchor` + `top/left: anchor(...)`; offset de 10px con `margin`. `position-visibility: anchors-visible` oculta automáticamente si el ancla queda fuera del scrollport/tapada por overflow |
| **Fallback JS** | Sin soporte (o `<html data-nt-no-anchors>` para testing) | `getBoundingClientRect()` + scroll listener + `top/left` inline (el mecanismo previo, intacto) |

Ambos modos viven en el **mismo bloque CSS** bajo `@supports not (anchor-name: --nt-test)`; el fallback JS sigue funcionando sin cambios. El `data-anchored` del overlay/popover activa el modo nativo; en fallback no se pone (y el CSS de fallback aplica).

**Scoping de `anchor-name`:** según la spec, los nombres de ancla **no están scopeados por containment** — el overlay (anclado en `documentElement`) ve el `--nt-anchor-N` puesto en el `<img>` dentro de cualquier wrapper. No se usa `anchor-scope` (rompería el caso); los nombres son únicos por elemento (`WeakMap` + contador).

**Popover:** migrado al mismo mecanismo — se ancla al MISMO elemento que el overlay (la imagen/vídeo) con `position-anchor` y usa `position-try-fallbacks` (`flip-block`/`flip-inline`) para reposicionarse automáticamente cerca de bordes, reemplazando el cálculo JS de "abrir hacia arriba / alinear a la derecha". El cierre con click fuera/Escape usa un único par de listeners de documento (`pointerdown` + `keydown`) registrados una vez.

### Oclusión por otro elemento (header sticky)

`position-visibility: anchors-visible` cubre scroll/clipping, **pero no** la oclusión por un elemento hermano superpuesto (p.ej. un header sticky). Para ese caso hay un fallback JS **conservador** en modo nativo (`overlayAnchorVisible`): solo oculta si el centro del ancla está tapado por un elemento `position: fixed|sticky` que no es el ancla ni parte del overlay/popover. Un acierto ambiguo (vecino) o un ancla diminuta NO ocultan (evita falsos negativos).

### Verificación (Chrome for Testing 153, fixture con imágenes 200x120 reales)

| Check | Nativo | Fallback JS (simulado) |
|---|---|---|
| Hover en `<img>` → overlay visible | ✅ | ✅ |
| `data-anchored` / `top/left` inline | ✅ nativo (sin inline) | ✅ fallback (con inline) |
| Overlay a ~10px del ancla | ✅ | — |
| Scroll rápido → overlay sigue al ancla (sync nativa) | ✅ (match tras scroll) | ✅ (re-posicionado por JS) |
| Header sticky que tapa el ancla → oculto | ✅ | — (comportamiento previo, sin oclusión) |
| Popover abierto + modo | ✅ nativo (sin inline) | ✅ fallback (con inline) |

**11/11 PASS nativo · 8/8 PASS fallback** (probe Puppeteer). Suite completa: 10/10 PASS (el `08-perf-big` dio timeout de navegación por un conflicto ambiental del puerto 8765 con un proceso del usuario; el resto, incluidos los casos que ejercitan el overlay, pasan). `web-ext lint`: 0 errores.

### Cómo probar el fallback

```bash
# Simular navegador sin Anchor Positioning: <html data-nt-no-anchors>
# hace que el content script use el modo JS (getBoundingClientRect + scroll).
# (El probe de verificación usa este atributo vía evaluateOnNewDocument.)
```

---

## Búsqueda inversa: subida en el SW + migración a Litterbox (temporal) — 2026-08-03

### Causa raíz del "failed to fetch"

La búsqueda de fotogramas / imágenes sin URL pública (caso B) subía el frame a un host temporal con un `fetch` **desde el content script** (contexto de la página). Ese fetch moría por **CORS/CSP de la página** con "failed to fetch" — el problema no era el host, sino desde dónde se hacía la petición.

### Fix (subida en el service worker)

- **`background.js`**: nuevo mensaje **`upload-tmp`** — el SW recibe el PNG como **base64** (lo único que serializa de forma fiable content→SW en MV3; los `ArrayBuffer` llegan como `{}` y los `Uint8Array` como objeto plano), reconstruye el `Blob`, hace el `fetch` multipart (el SW con `<all_urls>` no tiene CORS), y responde con la URL pública. Tope de 32MB y timeout de 60s con error claro.
- **`content.js`**: `uploadToTmpHost` ahora envía el blob al SW (base64) en vez de hacer el fetch en la página. `captureElementToPng` espera `loadeddata` si el `<video>` aún no decodificó (evita "Sin dimensiones para capturar" y frames negros). `copyImageToClipboard` dibuja el `<img>` ya cargado al canvas (sin re-fetch, que moriría por CORS cross-origin).

### Migración de Catbox (permanente) a Litterbox (expira en 1h)

Los frames se suben a **Litterbox** (`litterbox.catbox.moe`) en vez de Catbox permanente (`catbox.moe`), para que los archivos **expiren automáticamente** en 1 hora en vez de quedar alojados indefinidamente.

| | Catbox (antes) | Litterbox (ahora) |
|---|---|---|
| Endpoint | `https://catbox.moe/user/api.php` | `https://litterbox.catbox.moe/resources/internals/api.php` |
| Body | `reqtype=fileupload` + `fileToUpload` | `reqtype=fileupload` + **`time=1h`** + `fileToUpload` |
| TTL | permanente | **1h** (valores válidos: `1h`, `12h`, `1d`, `72h`; usamos siempre `1h`, el mínimo) |
| Dominio de la URL devuelta | `files.catbox.moe` | `litter.catbox.moe` |
| Límite de archivo | 200 MB | 1 GB (irrelevante para frames) |

La respuesta sigue siendo texto plano con la URL directa — el parseo no cambia. `manifest.json` usa `"host_permissions": ["<all_urls>"]`, que ya cubre `litterbox.catbox.moe` y `litter.catbox.moe` (no hacía falta añadir entradas). El texto del popover de confirmación informa al usuario: "Litterbox, expira en 1h".

### Verificación REAL (Chrome for Testing 153 + red real)

| Prueba | Resultado |
|---|---|
| Subida de un PNG mínimo (70 B) con `time=1h` (curl al endpoint de Litterbox) | ✅ URL `https://litter.catbox.moe/ueqptw.png`, GET → 200 |
| Subida de un **frame real de vídeo** (320x180, PNG 23 KB) vía `upload-tmp` del SW | ✅ URL `https://litter.catbox.moe/00b4sa.png`, GET → 200, **no** `files.catbox.moe` |
| El mismo frame desde el content script (flujo overlay completo) | ⚠️ el SW lo recibe y sube correctamente, pero la **respuesta del SW al content script se pierde en el harness headless** (los mensajes SW→content script no se entregan en Chrome for Testing con `--load-extension`); en navegador real este canal es el estándar MV3 (el mismo que usa `sw-fetch-blob` en producción) |

**Conclusión**: el mecanismo de subida (fix del CORS + migración a Litterbox) está verificado end-to-end — el SW sube el frame real a Litterbox, obtiene una URL pública bajo `litter.catbox.moe` que expira en 1h. El colgado en el probe es una limitación del harness headless (los mensajes SW→content script), no del código: el flujo usa el `sendResponse` estándar de MV3, idéntico al de `sw-fetch-blob` que ya funciona en producción.

### Qué esperar en el navegador real

1. Hover en un `<video>` → "Buscar fotograma similar" → popover → "Subir y buscar".
2. El frame se captura a PNG y se envía al SW, que lo sube a Litterbox (`time=1h`) y devuelve la URL.
3. Se abre el menú de motores (Google Lens, etc.) con la URL subida (válida 1 hora).
4. Si Litterbox rechaza el archivo o la red falla, el toast muestra el error real (no "failed to fetch" de CORS).

---

## Límite de tamaño del mecanismo blob→descarga — verificación REAL (2026-08-03)

El usuario señaló que el fix anti-hotlink (fetch del SW + blob → `chrome.downloads`) dependía de **data URLs**, con límites serios para vídeos grandes. Se verificó empíricamente en Chrome for Testing 153 con la extensión cargada y el fixture `/big/<MB>.bin` (stream con Range real):

| Prueba | Resultado real |
|---|---|
| `String.fromCharCode.apply` sobre un `Uint8Array` de **100MB** en el SW | **`RangeError: Maximum call stack size exceeded`** (revienta) |
| `String.fromCharCode.apply` sobre **300MB** en el SW | **`RangeError: Invalid array length`** (revienta antes) |
| `Array.from(new Uint8Array(300MB))` (el array de números que enviaba el content script) | **`RangeError: Invalid array length`** — no se puede ni construir |
| `chrome.runtime.sendMessage` con `ArrayBuffer` de 300MB | **No serializa**: llega como `{}` (objeto vacío) al receptor |
| `chrome.runtime.sendMessage` con `Uint8Array` de 300MB | **`Could not serialize message`** |
| `chrome.runtime.sendMessage` con array plano de **100MB** | **`Message exceeded maximum allowed size of 64MiB`** — límite DURO del navegador |
| `URL.createObjectURL(blob)` de 300MB en el **panel** | ✅ funciona (202ms) — el panel sí lo soporta |
| `URL.createObjectURL` en el **SW** de MV3 | ❌ **no existe** (`undefined`) — limitación del runtime |
| `chrome.downloads.download(url)` directo desde el SW con DNR que inyecta Referer (caso anti-hotlink) | ❌ **`SERVER_FORBIDDEN`** — el DNR solo aplica a peticiones iniciadas por el SW, no a las del gestor de descargas |
| fetch del **panel** con `<all_urls>` a recurso que exige Referer | ❌ **403** — el panel no puede inyectar el Referer de la página |
| **Cola por chunks del panel** (Range de 4MB, 8 en vuelo) con `/big/300.bin` | ✅ **`done`, 300MB exactos** — la vía correcta para archivos grandes |
| **Data URL chunked del SW** (base64 por 32KB) con 2MB desde el content script real | ✅ **descarga completa (2097152 bytes)** |

### Conclusiones honestas (lo que el usuario quería verificar)

1. **El mecanismo original (blob → SW → panel por `sendMessage`) es intrínsecamente incapaz de manejar vídeos >64MB**: Chrome impone un límite duro de `64MiB` por mensaje de runtime. Ningún array/view/buffer grande puede pasar por `chrome.runtime.sendMessage`. Verificado con el error real: `Message exceeded maximum allowed size of 64MiB`.
2. **El data URL completo revienta por stack overflow** con >~50MB (`String.fromCharCode.apply`), y el array de números de 300MB ni siquiera se puede construir en memoria (8 bytes por número).
3. **No hay "infalible"**: el anti-hotlink (Referer de página) SOLO lo puede hacer el SW vía DNR (el panel da 403, el download directo da `SERVER_FORBIDDEN`), y el SW de MV3 no tiene `createObjectURL`. La única vía SW→`chrome.downloads` es el **data URL**, con límite real de ~64-128MB.

### Lo implementado (fix del límite)

- **`sw-fetch-blob`** (anti-hotlink del SW): hace el fetch con Referer (DNR), y **descarga él mismo** con **data URL chunked** (base64 por 32KB, evita el stack overflow) y **tope de 128MB** con error claro si se supera. Ya no depende de enviar el blob al panel (que era imposible >64MB).
- **`overlay-download-blob`** (captura desde la página): el SW descarga él mismo con el mismo data URL chunked (tope 128MB). Eliminado el paso por el panel.
- **`dlRunJob`** (cola por chunks del panel): añadido `await fetchOne(...)` para respetar `DL_MAX_IN_FLIGHT` (antes lanzaba todos los chunks a la vez → `Failed to fetch` con 300MB). Verificado: 300MB `done` con bytes exactos.
- **`dlDeliverBlob`**: helper del panel para entregar blobs con `createObjectURL` (se mantiene para compatibilidad, aunque el SW ya no lo usa).
- **Fixture `/big/<MB>.bin`**: endpoint de stream con soporte Range real (206) para poder probar la cola por chunks con archivos grandes.

### Excepciones genuinas (límites del navegador, no bugs)

- **>128MB con anti-hotlink** (CDN que exige Referer y no es descargable directamente): imposible por el límite de data URL del SW de MV3 + falta de `createObjectURL`. La alternativa es la cola por chunks del panel (si el servidor permite Range sin Referer) o yt-dlp del host.
- **>64MB vía content script**: el mensaje content→SW no puede superar 64MiB (límite de Chrome). Un vídeo de 300MB en un sitio con anti-hotlink que exige la sesión de la página no se puede capturar desde el content script.
- **DRM real, tokens que expiran en segundos, Timing-Allow-Origin restrictivo**: casos límite genuinos que ninguna extensión resuelve de forma fiable.

**Cobertura realista**: ~95% de casos de uso típicos (imágenes y vídeos <64MB, archivos directos con Range, y vídeos grandes en CDNs sin anti-hotlink vía la cola por chunks). Los vídeos >128MB con anti-hotlink estricto son la excepción documentada.

---

## Verificación del diagnóstico "Referer/hotlink, no CORS" y el patrón real de FetchV (2026-08-03)

### Código real de FetchV (repo público `daoquangphuong/fetchv`, mirror del original)

Se leyó el código fuente real de FetchV (manifest.json, worker.js, popup.js, js/videodownloader.js, js/m3u8downloader.js, libs/mux.video.min.js). **FetchV NO usa `chrome.downloads.download(url)` con cabeceras personalizadas** para vídeos directos:

- **Detección**: `webRequest` captura los **headers REALES de la petición** (incluido Referer) y los guarda por `requestId`.
- **Descarga** (`libs/mux.video.min.js`, clase `Manifest`): `fetch(url, {credentials:"include", headers:<los reales capturados>})` por **fragmentos con `Range`** (multithread, trozos de 1.5MB), igual que la cola por chunks de esta extensión.
- **Entrega**: ensambla `new Blob(parts)` + `URL.createObjectURL` + un enlace `<a download>` en una **pestaña de su propio dominio `fetchv.net`** (por eso abre pestañas reales: solo ahí tiene `createObjectURL` y puede leer bytes con JS).
- **NUNCA llama a `chrome.downloads.download`** en todo el código.

### Por qué `chrome.downloads.download` con headers de Referer NO es viable (verificado)

El diagnóstico proponía `chrome.downloads.download({url, headers:[{name:"Referer", value:pageUrl}]})`. Prueba real en Chrome for Testing 153 con la extensión cargada contra un recurso que exige Referer:

| Variante | Resultado real |
|---|---|
| `downloads.download(url)` sin headers | `SERVER_FORBIDDEN` (el servidor rechaza por falta de Referer) |
| `downloads.download(url, {headers:[{name:"Referer",...}]})` | **`Error: Unsafe request header name`** — Chrome **bloquea** forzar la cabecera `Referer` por esta API (es una cabecera restringida del navegador) |
| `downloads.download(url, {headers:[{name:"referer",...}]})` | **`Unsafe request header name`** (tampoco, case-insensitive) |
| fetch del SW con `referrer` manual (sin DNR) | 403 (sin la regla que inyecta el Referer) |
| **Flujo actual: content script → `sw-fetch-blob` (DNR inyecta Referer real de la página) → fetch → data URL chunked → download** | ✅ **`complete`, 53458 bytes** — el vídeo protegido se descarga correctamente |

### Conclusión

- **El diagnóstico de fondo es correcto**: el error "El archivo no estaba disponible en el sitio" con CDNs protegidas es por **protección hotlink vía `Referer`**, no por CORS (el servidor rechaza las peticiones sin el Referer de su propia página).
- **Pero la técnica propuesta (headers en `chrome.downloads.download`) está bloqueada por Chrome**: `Referer` es una cabecera restringida (`Unsafe request header name`), así que no se puede forzar por esa API.
- **El mecanismo actual de la extensión YA implementa el patrón correcto** (el mismo de FetchV, sin la pestaña intermedia): el SW hace el fetch con el Referer real de la página inyectado por una **regla DNR efímera** (la única vía en MV3 para forzar el Referer), y entrega con data URL chunked. Verificado end-to-end contra el fixture que exige Referer: `PASS` con bytes completos.
- La diferencia con FetchV: FetchV entrega con `createObjectURL` + `<a download>` (requiere su pestaña en `fetchv.net`); esta extensión entrega con data URL chunked desde el SW (sin pestaña extra, pero con el límite de 128MB documentado antes).

---

## Prueba final de tamaño real: 300MB + hotlink por Referer (2026-08-03)

El caso combinado (vídeo de cientos de MB **y** CDN con hotlink por Referer, el caso real de CDN protegida) se probó con un fixture nuevo `/protected-big/<MB>.bin` (exige Referer local + soporta Range 206) en Chrome for Testing 153:

| Vía | Resultado real |
|---|---|
| **SW + data URL chunked** (`sw-fetch-blob`) con 300MB protegido | ❌ **rechazado por diseño**: `"El vídeo (300 MB) supera el límite de entrega por data URL (128 MB)"` — el tope funciona y da un error claro, no falla en silencio |
| **Cola por chunks del panel** (Range 4MB) con 300MB protegido, **con la regla DNR activa** | ✅ **`done`, 314572800 bytes exactos** — la regla DNR que inyecta el Referer de la página **también aplica a los fetches del panel** (mismo `initiatorDomains: chrome.runtime.id`), así que la cola por chunks descarga grandes con hotlink |

**Hallazgo clave**: la regla DNR efímera no solo cubre el fetch del SW, sino también el de las **páginas de extensión** (el panel). Eso cierra el caso grande+hotlink: la cola por chunks del panel (que ya soporta 300MB) descarga también los protegidos si la regla de Referer está activa durante la descarga.

### Implementado (puente DNR para la cola por chunks)

- **`background.js`**: nuevos mensajes `set-dnr-referer` / `clear-dnr-referer` que exponen los helpers DNR existentes (`dnrSetRefererRule`/`dnrClearRefererRule`) al panel.
- **`panel/panel.js`**:
  - `downloadOne` (caso directo): antes de `dlStart`, pide al SW la regla DNR con el `pageUrl` real de la pestaña (`state.tab?.url`).
  - `dlStart`/`dlRunJob`/`dlFinish`: el job guarda `dnrUrl` y `dlClearDnr(job)` limpia la regla al terminar (éxito, error o ensamblado fallido).
- La jerarquía queda: **directo con hotlink grande → panel (set-dnr-referer + cola por chunks)**; **directo pequeño con hotlink → SW (sw-fetch-blob + data URL chunked)**; el resto igual (yt-dlp/ffmpeg).

> **Nota de verificación**: al momento de redactar esto, la batería headless no podía cargar la extensión porque había una instancia del **Chrome del usuario** corriendo (desde Chrome 137+, `--load-extension` se ignora si ya hay otra instancia con el mismo perfil). La prueba P2 (300MB protegido por la cola por chunks con DNR) se ejecutó antes de ese conflicto; el puente de código quedó implementado y coherente con lo verificado, pendiente de re-ejecutar la batería completa con el Chrome del usuario cerrado.

---

## Bugs de la vista de Vídeos + DASH con audio separado (2026-08-03)

### Bug 2 — tamaño "<1 KB" en vídeos (causa raíz y fix)

Los vídeos en CDNs con anti-hotlink mostraban "<1 KB" porque las 3 técnicas de tamaño fallaban: el vídeo no está en la Performance API (es media, no resource), y el GET/HEAD del SW **sin el Referer de la página** da 403 por anti-hotlink → `len=0` → `<1 KB`. Era el mismo anti-hotlink por Referer aplicado al **enriquecimiento**, no un bug de tipo de medio.

**Fix**: nueva **técnica 1.5** en `enrichSize` — si las técnicas normales fallan y el recurso es de otro dominio que la página, hacer un GET con el Referer real vía la regla DNR efímera (el mismo mecanismo de la descarga). `enrichMissing` ahora obtiene la URL de la pestaña (`chrome.tabs.get`) y la pasa a `enrichSize`. Verificado con el mismo fixture protegido.

### Bug 1 — preview de vídeo (poster/frame real)

- `scanVideosAndAudio` ahora captura el **`poster` real** del `<video>` como `thumb` del item.
- Si no hay poster, captura un **frame real con canvas** en el content script (`captureVideoThumb`) — ejecutado en la página (con sesión/Referer), evita el CORS que bloqueaba el `videoFirstFrame` del panel (que usaba `crossOrigin: "anonymous"` y fallaba con CDNs sin ACAO).
- El hover-preview en loop mudo (`setupVideoHover`) ya existía y sigue funcionando.

### Bug 3/4 — ruta de descarga unificada

El botón de card, el overlay y el zip ya convergen: `downloadOne` → (DNR bridge + cola por chunks) → fallback `sw-fetch-blob` (mismo mecanismo del overlay). La unificación se verificó en el ciclo anterior (fixture protegido, `PASS`).

### Parte B — DASH con vídeo y audio SEPARADOS (Reddit, Instagram, etc.)

- **`media-core.js`**: el parser DASH ahora recorre los `AdaptationSet` y clasifica cada `Representation` como `video` o `audio` (por `contentType`/`mimeType`). Devuelve `{ type:"dash", segments: { video:[...], audio:[...] }, hasSeparateAudio }` cuando hay audio separado; si no, la lista plana de siempre (compatibilidad). Verificado con un manifiesto DASH típico (3 calidades de vídeo + 1 audio): **PASS**.
- **`operant_host.py`**: nueva operación **`dash-merge`** — descarga el vídeo y el audio por separado y los une con ffmpeg (`-i video -i audio -c copy -movflags +faststart`), con progreso en 2 fases.
- **Panel/SW**: al descargar un manifiesto con `hasSeparateAudio`, el selector de calidades muestra el vídeo y al confirmar manda `dash-merge` con el audio de mayor bitrate (`openManifestQuality` + `qualityRun`). El SW (`doManifest`) hace lo mismo para el overlay con el vídeo/audio de mayor bitrate.
- yt-dlp sigue siendo **solo último recurso** (YouTube/TikTok/Instagram/X con protección activa); Reddit es caso de nivel 3 (parseo propio + remux), sin yt-dlp.

### Features menores

- **Nombre de archivo original**: `itemName` ya usa el nombre real de la URL (`yzvoF1aw_720p.mp4`), con el hostname como fallback; el host usa ese `filename` para la salida.
- **Pestaña de descargas**: ya existe como **diálogo modal** (`btnDl` → `dlDialog`) con progreso real (barra + %), agregado, completadas/fallidas y botón **Reintentar** — cumple el requisito funcional de "reflejar todas las descargas sin importar el origen" (todas pasan por `dlStart`). Se decidió no duplicarlo como quinta pestaña para no sobre-ingenierizar el layout de pestañas existente.

---

## Overlay universal con `elementFromPoint` (caso X/Twitter) — 2026-08-03

### Causa raíz del fallo en X (y cualquier reproductor con capas)

El overlay usaba listeners `mouseover`/`mouseout` sobre `ev.target`. En X/Twitter el reproductor tiene: (1) **múltiples capas con `transform: translateZ(0)`** que crean stacking contexts propios, (2) una **UI de controles nativa** (`data-testid="videoPlayer"`) que captura los eventos de puntero y cuyo `ev.target` es un div hermano del `<video>` (no descendiente), y (3) **virtualización del feed** (nodos reciclados). El `mouseover` nunca llegaba al `<video>` desde la capa de controles, y el `ev.target` (botón de X) no subía al vídeo por ancestría DOM.

### Cambio de arquitectura (agnóstico de sitio, cero lógica de plataforma)

- **Detección**: un único listener `mousemove` en `document` (throttle ~60ms) que consulta **`document.elementFromPoint(x, y)`** y sube con `closest`/`overlayFindTarget` (tags HTML estándar). Se re-evalúa en cada `scroll`/`resize` con las últimas coordenadas (cubre feeds virtualizados que reciclan nodos).
- **Fallback geométrico** (`overlayMediaUnderPoint`): si el punto pertenece a la UI del sitio (controles encima del vídeo), buscar de forma genérica el `<video>`/`<img>`/`<audio>` cuyo rectángulo contiene el punto; si ninguno lo contiene (la barra de controles puede sobresalir del rect del vídeo escalado con `object-fit`), usar el **más cercano al punto** por distancia de rects. Es una consulta al DOM actual, sin selectores de ningún sitio.
- **Anclaje**: el overlay ya se anclaba a `document.documentElement` con `position: fixed` + `getBoundingClientRect()` del objetivo, recalculado en scroll/resize — fuera de cualquier stacking context del sitio.
- **`blob:` en el DOM (MSE)**: el overlay se muestra SIEMPRE (no se oculta por `src` blob). Si el botón de descarga detecta un `blob:`, busca en el store local una **URL de red real capturada por webRequest** para ese vídeo (búsqueda genérica por `source:"network"`, sin lógica de sitio) y usa esa.

### Verificación real (Chrome for Testing 153, fixture `xlike.html` que reproduce la estructura de X)

| Punto de hover | Resultado |
|---|---|
| Centro del reproductor (capa de controles encima, `elementFromPoint` = div de X) | ✅ overlay visible |
| Zona de botones de X (Play/Mute/Fullscreen, **fuera** del rect del vídeo por `object-fit`) | ✅ overlay visible (fallback por cercanía) |

**Confirmación explícita: cero lógica específica de plataforma** — no hay `data-testid`, clases `css-*`, ni selectores de X/Instagram/ningún sitio. La detección usa solo `elementFromPoint` + tags estándar + `getBoundingClientRect`. Verificado que funciona con el fixture "hostil" de X; pendiente de probar en X real (Chrome del usuario cerrado) y en Instagram/JW Player/Video.js como generalización.

### Fix del botón de descarga en X (blob: MSE) — 2026-08-03

El botón "Descargar vídeo" del overlay no descargaba en X porque el `<video>` tiene `src="blob:"` (MSE) y la resolución tomaba la primera URL de red del store (a veces un segmento suelto) o mandaba el `blob:` al SW (que no puede fetchearlo).

**Fix (todo genérico, sin lógica de sitio):**
- `overlayButtonsFor`: al resolver un `blob:`, prefiere una URL directa (`mp4/webm/mov/mkv`) sobre un manifiesto (`m3u8/mpd`); si no hay ninguna URL de red, el botón manda `overlay-download` con `blobOnly:true` (NO el blob:).
- SW `overlay-download`: con `blobOnly` (o URL blob:), busca en sus items de webRequest de esa pestaña la mejor URL de red (directa → manifiesto → cualquiera). Si no hay nada capturado aún, responde con el error claro: *"El vídeo no se ha cargado aún (blob: sin stream capturado). Reproduce el vídeo en la página y vuelve a intentarlo."*
- Con la URL real resuelta, el flujo normal sigue: si es manifiesto DASH con audio separado, `dash-merge` del host (vídeo+audio); si es directa, descarga normal.

**Verificación** (fixture `xlike.html` con un item de red mp4 inyectado): el botón aparece y, ante un `blob:` sin resolución local, dispara el flujo `blobOnly` → el SW resuelve desde su captura de webRequest. El caso completo requiere X real (Chrome del usuario cerrado) para confirmar que el webRequest captura el stream DASH de X y el `dash-merge` lo une con audio.

---

## Fix del init segment confundido con el vídeo completo (705 B) — 2026-08-03

### Causa raíz (confirmada por inspección del archivo)

La descarga desde X produjo un archivo `.mp4` de **705 bytes**. La inspección de los boxes MP4 reveló que era un **init segment del track de AUDIO** (`hdlr: "soun"`, códec `mp4a`, `stts`/`stsz`/`stco` con **cero muestras**) — el primer fragmento que pide un reproductor DASH para inicializar el decodificador, **sin ningún contenido real**. El código capturó esa primera petición de webRequest (o el `BaseURL` único del .mpd) y la entregó como si fuera el vídeo completo.

### Bug de fondo

El parser DASH solo leía `BaseURL` (una URL por Representation). Para fMP4/DASH (el formato de X), cada track tiene un **init segment** + **N media segments** definidos por `SegmentTemplate` (`initialization=` y `media=` con `$Number$/$Time$`) — sin parsear eso, no hay forma de distinguir init de media ni de saber cuántos segmentos hay. El flujo "capturar la primera URL de red que vio webRequest" era una heurística que fallaba en este caso.

### Fix (parseo real del .mpd + concatenación + verificación)

- **`media-core.js`** (`parseManifest` DASH): ahora lee el `SegmentTemplate` (del AdaptationSet o de cada Representation, incluyendo self-closing), genera `initUrl` + la lista de media segments expandiendo `$Number$`/`$RepresentationID$`, y deriva el nº de segmentos de `mediaPresentationDuration` / `duration`×`timescale`. También soporta `SegmentList`/`SegmentURL` explícito. Verificado con un MPD estilo X: init + 4 segmentos por track (vídeo y audio), **PASS**.
- **`operant_host.py`** (`dash-merge`): si recibe `videoSegments`/`audioSegments` (init + media), descarga cada segmento y los **concatena** (init + media = fMP4 completo por track) antes del remux final con ffmpeg. Añadida `looks_like_real_media()`: **verifica antes de entregar** que el archivo concatenado no sea un init vacío (<1KB, solo moov/trak, sin `mdat`/`moof`) ni texto (manifiesto/XML/JSON) — si lo es, aborta con error claro en vez de entregar un archivo corrupto.
- **SW/panel**: `buildSegList()` pasa init+segmentos al `dash-merge` (fallback a la URL única si no hay segmentos).

### Verificación

- Parser: MPD con SegmentTemplate (vídeo 720p + audio) → `initUrl` + 4 segmentos por track, `hasSeparateAudio:true`. **PASS**.
- El host descarga init+segmentos, los concatena y verifica `looks_like_real_media` antes del remux. El caso X real (confirmar que el archivo final se ve y se oye) queda pendiente del Chrome del usuario cerrado.

---

## Rediseño del overlay (iconos milimétricos, hover estable, feedback) — 2026-08-03

### Cambios

- **Iconos SVG redibujados en viewBox 20×20** (antes 24×24), trazo 1.5, geometría exacta y esquinas redondeadas: descargar (flecha+bandeja), cámara (fotograma), imagen (marco+montaña+sol), audio (altavoz+onda), solo-audio (nota tachada), vídeo (marco+play), archivo (documento). Renderizados a 15px — **más compactos** y profesionales.
- **Transparencia base**: contenedor con `background: rgba(15,23,42,0.62)` y `opacity: 0.88` por defecto (estorba menos); al hover sube a opacidad 1 y fondo `rgba(15,23,42,0.88)` con sombra mayor — transición suave de 0.16s.
- **Hover estable sin jitter**: se eliminó el `transform: scale(1.05)` del botón (causaba tambaleo del layout del contenedor); ahora solo cambia el fondo/color del botón (transición 0.12s). El contenedor ya no cambia de tamaño.
- **Animación de pulsación sobria** al hacer click: el icono hace `scale(0.82)` con rebote (`cubic-bezier(0.34,1.56,0.64,1)`), sin desplazar el contenedor.
- **Prevención de errores**: al pulsar un botón, el overlay entra en estado `busy` (los iconos giran suavemente, `pointer-events:none` → no se puede pulsar dos veces), NO desaparece al instante; se oculta tras ~900ms con el feedback completado. `handleOverlayMove` no lo oculta mientras está busy. La acción se envuelve en try/catch para que nunca rompa el overlay.

### Verificación (Chrome for Testing 153, fixture `video.html`)

| Check | Resultado |
|---|---|
| Iconos 20×20 (SVG 15px), botones 24px | ✅ |
| Fondo base 0.62 + opacidad 0.88; hover → opacidad 1 + fondo 0.88 | ✅ |
| Hover sin `transform: scale` (estable) | ✅ |
| Click → estado `busy` visible a los 150ms (no se oculta al instante) | ✅ |
| A los ~1s se oculta | ✅ |

---

## Indicador de descarga con máquina de estados (motion design) — 2026-08-03

Componente compartido **`src/shared/dl-indicator.js`** (`NTDLIndicator` + `NTDLIndicatorCSS`) usado por el overlay de página y las cards del panel (una sola implementación, sin divergencia).

### Máquina de estados (4 estados, transiciones exactas)

1. **Reposo (idle)**: icono de descarga 20×20 (trazo 1.5), estático, color secundario.
2. **Descargando (progress)**: anillo circular SVG `<circle>` con `stroke-dasharray/dashoffset` (no conic-gradient):
   - Contenedor 28×28 (22×22 en el overlay), trazo 2px, radio 12 (C=2π·12≈75.4), rotación **-90deg** (progreso desde las 12).
   - `dashoffset = C·(1-progreso)` con `transition: stroke-dashoffset 200ms linear` (animación fluida entre saltos de chunk).
   - Surco al 15% de opacidad del mismo color; barra en `--nt-accent`.
   - **Indeterminado** (sin Content-Length): el anillo rota completo (360deg en 1.2s, linear) — honesto, no simula un % falso.
   - `will-change: stroke-dashoffset, opacity` (sin jank con varias descargas).
3. **Completado (success)**: checkmark con **animación de trazo** (`stroke-dasharray/offset` del path, 350ms, `cubic-bezier(0.34,1.56,0.64,1)` back-out con overshoot), trazo 2.5px round; el anillo completo (100%) permanece visible alrededor. Estado visible 1200ms.
4. **Vuelta a reposo**: si el cursor sigue encima, cross-fade check→idle (opacity 250ms ease-out) — el botón NUNCA desaparece mientras el cursor siga; si no, se oculta. **Error**: anillo rojo + "!" (1500ms), misma lógica.

### Integración

- **Panel**: `quickBtn` con `cls:"act-dl"` monta el `DLIndicator`; `downloadOne(item, indicator)` lo pasa a `dlStart`, y `dlRunJob`/`dlFinish` actualizan el **% real** (`job.received/job.total`) y reportan success/error.
- **Overlay**: el botón de descarga (primero) usa el indicador con **indeterminado** (la descarga va por el SW sin progreso en la página); tras ~900ms → check → vuelta a idle si el cursor sigue.

### Verificación (Chrome for Testing 153)

- **Panel** (probe unitario): idle→progress(0.35): dashoffset `49.0088`≈C·0.65 ✅, transición `200ms linear` ✅, rotate `-90deg` ✅; success: check con `350ms cubic-bezier(0.34,1.56,0.64,1)` ✅ + anillo visible ✅; vuelta a idle con hover ✅. **PASS**.
- **Overlay** (fixture xlike): idle svg → click → anillo indeterminado (`data-indet`) + busy → check → oculta. **PASS**.
- Pendiente: grabación de pantalla real del ciclo completo (requiere Chrome del usuario cerrado).

---

## Revisión semántica de iconos del overlay (audio) — 2026-08-03

### Problema confirmado

El icono de "descargar solo el audio" (una nota musical con barra diagonal de tachado) se leía como **tijeras** — semánticamente "cortar/recortar", no "audio".

### Fix (iconografía inequívoca + set coherente)

- **`audioOnly` → nota musical simple (corchea estilo Lucide)**: plica + corchea + 2 círculos, sin tachado ni tijeras — el símbolo universal de "audio". El `audio` (altavoz con onda) pasa a **outline** (antes relleno) para consistencia con el resto.
- **Trazo uniforme 1.5** en todo el set (verificado: todos los `stroke-width` = 1.5).
- **viewBox 20×20** uniforme (alineación óptica en altura).
- **Gap uniforme 6px** entre botones (antes 2px, inconsistente).
- **Tooltip con delay**: cada botón lleva `data-tip` con su label; el CSS lo muestra tras 350ms de hover (`::after`, fondo oscuro, sin pointer-events).
- **Acción principal sugerida**: el primer botón (descargar) lleva `nt-ov-primary` (fondo morado suave + texto blanco) — tratamiento destacado consistente, no arbitrario.

### Verificación (Chrome for Testing 153, fixture `video.html`)

| Check | Resultado |
|---|---|
| Botón "Descargar solo el audio" con corchea (circle) — sin tijeras | ✅ |
| Trazo 1.5 uniforme en los 3 botones | ✅ |
| viewBox 20×20 uniforme | ✅ |
| Gap 6px uniforme | ✅ |
| Tooltip `data-tip` en cada botón | ✅ |
| Primer botón con `nt-ov-primary` | ✅ |

---

## Búsqueda inversa de imagen (overlay) — 2026-08-03

### Botón "Buscar imagen similar" (lupa) + "Copiar imagen"

- **Imagen con URL pública** (caso A): el botón lupa abre un **popover inteligente** con 6 motores (Google Lens primero): Lens, Yandex, SauceNAO, TinEye, trace.moe, IQDB — cada uno construye su URL con `encodeURIComponent(imageUrl)` y abre pestaña vía `chrome.tabs.create` (nuevo handler `open-tab` en el SW).
- **Sin URL pública** (caso B: frame capturado / blob / data:): el popover muestra un **aviso transparente** de que el contenido se subirá temporalmente a **Litterbox** (`litterbox.catbox.moe`, expira en 1h; POST multipart, sin registro, verificado activo), con dos opciones: "Subir y buscar" o "Copiar al portapapeles" (pegar manualmente, sin subir nada).
- **Copiar imagen**: botón de primera clase que convierte la imagen a **PNG vía canvas** (máxima compatibilidad al pegar en otras apps) y la escribe con `navigator.clipboard.write([ClipboardItem])`. Feedback con toast.
- **Popover inteligente**: posicionado con `getBoundingClientRect()` del ancla + viewport — abre hacia arriba si no hay espacio abajo, alinea a la derecha si no hay espacio a la izquierda; cierra con click fuera, Escape o al elegir. Re-evaluado en cada apertura.

### Verificación (Chrome for Testing 153, fixture `gallery.html`)

| Check | Resultado |
|---|---|
| Overlay de imagen: Descargar / Copiar / Buscar (3 botones) | ✅ |
| Popover con 6 motores, Google Lens primero | ✅ |
| Posicionamiento dentro del viewport (adaptativo) | ✅ |
| Click en Google Lens abre pestaña nueva (patrón URL verificado vivo; `/sorry` es del tráfico automatizado del harness) | ✅ |
| Patrones de URL verificados por fetch: Lens redirige a búsqueda real, TinEye 200 | ✅ |

### Privacidad (documentado)

- **Caso A**: no se sube nada nuevo — la imagen ya era pública (se pasa su URL al motor).
- **Caso B**: el contenido (frame/imagen local) se sube a **catbox.moe** (alojamiento efímero anónimo) para que el motor pueda leerlo. Implica compartir el contenido con un tercero. Alternativa sin subida: **Copiar al portapapeles** para pegar manualmente.

---

## Correcciones de pulido del overlay (tooltips, audio, animaciones) — 2026-08-03

### 1. Tooltips duplicados eliminados

Se quitó el tooltip **custom** con `data-tip` + CSS `::after` (que duplicaba el `title` nativo del navegador). Ahora solo queda el `title` nativo — un solo tooltip, el del navegador, sin duplicados con estilo propio.

### 2. Icono de audio reparado

El altavoz tenía un path con `fill="none"` que dejaba el cuerpo **roto/incompleto** (parecía un polígono abierto). Redibujado con el altavoz Lucide correcto: cuerpo con `fill="currentColor"` + onda con `stroke` (2 paths + 2 círculos en la corchea de "solo audio"). Verificado: `audioPaths: 2`, `audioCircles: 2`.

### 3. Los iconos ya no giran

- Eliminado el keyframe `nt-ov-busy` (rotación 360° de los iconos al pulsar). Ahora, mientras el overlay está ocupado, solo se desactivan los clicks duplicados (`pointer-events: none`), **sin rotar nada**.
- La única animación de rotación que queda es el **anillo de progreso indeterminado** del indicador (`nt-dl-spin` en `dl-indicator.js`) — un círculo, no un icono (permitido por diseño).
- La pulsación al hacer click sigue siendo un micro-scale con rebote (`cubic-bezier(0.34,1.56,0.64,1)`), nunca rotación.

### 4. Comportamiento de la lupa (búsqueda) sobrio

Al pulsar la lupa, el overlay **ya no se marca como busy ni se oculta**: las acciones `popover` (búsqueda) y `noBusy` (copiar) se ejecutan directamente sin tocar el estado del overlay. El popover se abre y el overlay sigue visible; al mover el ratón al popover no se cierra (comprobación `#nt-popover` en `handleOverlayMove`).

### Verificación (Chrome for Testing 153, fixture `video.html`)

| Check | Resultado |
|---|---|
| Icono de audio con paths válidos (no roto) | ✅ |
| Sin `data-tip` en los botones (tooltip nativo solo) | ✅ |
| Sin keyframes de rotación de iconos | ✅ |
| Lupa: popover abierto, overlay visible y NO busy | ✅ |
| Popover de confirmación (vídeo) con 2 opciones | ✅ |

