# Operant — Brief para auditoría de gaps y plan de endurecimiento

> **Este documento es un prompt.** Está escrito para ser entregado tal cual a un modelo de
> frontera con acceso a lectura de repositorio y a búsqueda web. No es un informe de
> hallazgos: es el contexto crudo + las preguntas + las restricciones con las que debes
> producir el informe final.
>
> La sección 6 (defectos verificados) contiene hallazgos que **ya fueron confirmados leyendo
> el código**, con `archivo:línea`. No los re-verifiques desde cero: verifícalos si dudas,
> pero tu trabajo no es re-descubrirarlos, es decidir **qué hacer con ellos**.

---

## 1. Tu rol

Eres un **principal engineer de extensiones de navegador** con tres especificaciones:

1. **Manifest V3 de Chromium y MV3 de Firefox** — incluyendo el ciclo de vida del service
   worker, `declarativeNetRequest`, `webRequest` observacional, `sidePanel`, Native Messaging,
   y las restricciones reales de MV3 (no las de MV2).
2. **Ingeniería de descarga de medios a escala** — Range/206, `Content-Range`, streaming a
   disco, OPFS, resuming, anti-hotlink, cookies/auth, URLs firmadas con expiración, HLS/DASH,
   FFmpeg, yt-dlp.
3. **Ingeniería de calidad a escala de producto** — arquitectura de módulos, estrategia de
   testing, CI/CD, semver, seguridad de la cadena de suministro, y preparación para tiendas.

Trabajas con **juicio de arquitectura, no con listas de estilo**. No te limites a repetir
bugs. Tu valor está en el **orden de los trabajos** y en detectar las **decisiones
estructurales equivocadas** que cuestan caro arreglar.

---

## 2. Contexto de producto

**Operant** es una extensión de navegador multi-navegador, GPL-3.0-or-later, publicada en
`https://operant.planobinario.com` (web de marketing en repo aparte: `operant-web`, Astro).

**Lo que la extensión hace hoy:**

- Inyecta un content script en `<all_urls>` que **detecta medios y archivos** de la página
  (imágenes, vídeo, audio, ficheros) combinando escaneo DOM, `getComputedStyle`, CSSOM,
  regex sobre `outerHTML`, Performance Resource Timing y captura de red vía `webRequest`.
- Pinta un **overlay contextual** sobre la imagen bajo el cursor, con un popover de acciones.
- Ofrece un **panel lateral** (Chrome `sidePanel`) con grid/lista/masonry, filtros,
  selección, orden, y cola de descargas.
- **Descarga** por múltiples rutas: `chrome.downloads.download` directo, `fetch`+Blob en el
  service worker, cola por chunks Range en el panel, empaquetado ZIP con JSZip.
- Se apoya en un **host nativo en Rust** (Native Messaging) para ffmpeg (remux, merge
  DASH, extracción de audio, conversión) y yt-dlp.
- **Graba** medios interceptando `MediaSource.addSourceBuffer` en el mundo `MAIN`.

**Posicionamiento declarado:** "local-first media engine". La propuesta de valor es que la
extensión es el punto de control; el host nativo es la computation tier.

**Mercado objetivo:** gente que descarga medios de la web de forma masiva y organizada
(galerías, cursos, streams, repositorios). Es un público técnico que espera fiabilidad.

---

## 3. Estado real del repositorio

```
Ruta:        D:\40_workspace\10_dev\operant
Remote:      https://github.com/planobinario/operant.git
Rama:        main @ 6650571  ("docs: update README…")
Commits:     3 en main  (squash de una historia de 29) · 0 tags
```

**Léelo antes de nada. Trae material de trabajo sin commitear que ES el producto real:**

```
 M native-host-rs/src/ffmpeg_ops.rs   M src/background.js   M src/content.js
 M src/manifest.json                  M src/panel/panel.css M src/panel/panel.html
 M src/panel/panel.js                 M src/recorder-main.js
 M src/shared/hls-fast.js             M src/shared/media-core.js
 M package.json                       M native-host/operant-host.exe
?? src/panel/player.html              ?? src/shared/icons.js
```

- El diff sin commitear es de **+2.758 / −560 líneas** en 12 archivos, e **incluye una
  permissão nueva** (`scripting`) y **dos archivos nuevos sin trackear**.
- `src/shared/icons.js` está listado en `manifest.json` → `content_scripts[0].js`.
- `src/panel/player.html` se abre desde `panel.js` vía `chrome.runtime.getURL`.
- **Conclusión: un `git clone` de `main` no reproduce el producto.** `main` da manifest
  0.4.0 sin `scripting`, sin `icons.js`, sin `player.html`.

### 3.1 Escala y métricas

| Métrica | Valor |
|---|---|
| Archivos trackeados | 71 · 4,94 MB en git |
| `.git` en disco | 4,27 MB · **0 packfiles** (nunca `git gc`) |
| Worktree | 11.911 archivos · **~0,98 GiB** (98,6 % ignorado) |
| `src/` (sin vendor) | **13.296 LOC** JS |
| `native-host-rs/src/*.rs` | **1.438 LOC** Rust |
| `native-host/operant_host.py` | 740 LOC Python (host legacy) |
| `tests/` | 2.202 LOC JS + ~530 LOC Python |
| Vendor no minificado | `dash.all.min.js` 794 KB + `hls.min.js` 414 KB + `jszip.min.js` 98 KB |
| `panel.js` | **5.002 líneas / 190 KB** — monolito |
| `content.js` | 2.730 líneas / 108 KB |
| `background.js` | 1.861 líneas / 78 KB |
| CI | **0 ficheros de configuración** |
| Lint / format / typecheck | **ausentes** |
| Tests unitarios | **0** |

### 3.2 Mapa de módulos

```
src/manifest.json        MV3. permisos: storage, activeTab, sidePanel, downloads,
                         webRequest, webNavigation, nativeMessaging,
                         declarativeNetRequest, scripting + host_permissions <all_urls>
                         background: service worker (module)
                         content_scripts[0]: icons.js + dl-indicator.js + content.js @document_idle
                         content_scripts[1]: recorder-main.js @document_start, world: MAIN

src/background.js        SW. Red (webRequest), enriquecido de tamaños, relaciones de stream,
                         iframe-scoped network-capture, estrategia de descarga, cola/bridge
                         nativo, DNSR Referer, grabación, subida Litterbox. 29 tipos de mensaje.
src/content.js           Motor de detección (15 fases de escaneo), overlay, popover,
                         captura de miniaturas, resolución blob:.
src/shared/media-core.js  "ÚNICA FUENTE DE VERDAD" de clasificación. extOf, classify,
                         parseManifest (HLS+DASH), detectMagic, trackTypesOf (box walk MP4),
                         probeMedia, classifyDownload.  ← SE USA AL CLIC, NO AL DETECTAR
src/shared/hls-fast.js   Motor HLS en el SW: parseMaster/parseMedia, AES-128, byteranges,
                         descarga VOD y live, mux TS/fMP4. Exportado CJS+ESM (SW y panel).
src/shared/dl-indicator.js  Indicador de descarga en la página.
src/shared/icons.js      Iconos SVG (UNTRACKED).
src/panel/panel.js       Panel lateral completo + cola de descargas por chunks + ZIP.
src/recorder-main.js     Hook MSE.addSourceBuffer (mundo MAIN) + puente postMessage.

native-host-rs/src/      main.rs (dispatch) · protocol.rs (framing) · ffmpeg_ops.rs ·
                         ytdl.rs · tools.rs (HTTP, descarga de ffmpeg/yt-dlp) ·
                         recorder.rs · installer.rs
native-host/             MANIFEST del host + operant-host.exe COMMITIDO + operant_host.py
                         (implementación Python legacy aún referenciada por install_host.bat)
scripts/build-firefox.mjs
tests/                   run-verification.js · run-panel-audit.js · fixtures-server.js ·
                         generate-fixtures.js · host-e2e.py · rec-e2e.py · fixtures/ · results/
```

**Observación arquitectónica clave:** la detección y la verdad de bytes están **desacopladas
y desalineadas**. `content.js` decide `type`/`ext` **solo con regex sobre strings de URL**.
`media-core.js` tiene la verificación real (magic bytes, `Content-Type`, box parsing) pero
**solo se invoca cuando el usuario hace clic**. Resultado: todo el grid, todos los filtros,
todos los contadores y todas las decisiones de UI descansan sobre conjeturas.

---

## 4. Cómo debes trabajar

1. **Lee el código, no este documento.** Este brief te dice dónde mirar:
   `src/background.js`, `src/content.js`, `src/shared/media-core.js`, `src/shared/hls-fast.js`,
   `src/panel/panel.js` (al menos las zonas de descarga y cola), `src/recorder-main.js`,
   `native-host-rs/src/*.rs`, `src/manifest.json`, `package.json`, `TESTING.md`.
2. **Usa `git diff` y `git show`** para entender qué es nuevo y qué es deuda histórica.
3. **Investiga en internet.** Es un requisito explícito, no un extra. Ver §8.
4. **Entrega un plan, no uncódigo dump.** Ver §9 para el formato exacto.

---

## 5. La pregunta nuclear

> ¿Qué gaps debemos cerrar para que la extensión sea **muchísimo más robusta, profesional,
> atómica y de alta calidad**?

Interpretamos «atómica» en **tres** sentidos; trátalos como tres ejes distintos:

- **A1 — Atomicidad de la descarga.** El resultado en disco debe ser correcto o no existir.
  Nunca un `.mp4` truncado, nunca un archivo ensamblado con huecos, nunca un directorio de
  temporales huérfano, nunca un archivo con el nombre que la UI prometía pero no se escribió.
  La descarga es una **transacción**: commit o rollback.
- **A2 — Atomicidad del código.** Módulos con una responsabilidad, una fuente de verdad por
  dato, funciones que no mutan estado global de forma implícita, ninguna función de 1.500
  líneas, sin estado compartido entre contexts sin contrato declarado. Hoy `panel.js` tiene
  5.002 líneas y el servicio worker y el content script **reimplementan** `extOf` con
  resultados distintos (`content.js:104` vs `media-core.js:26`).
- **A3 — Atomicidad del cambio.** Commits y PRs unitarios, semver estricto, cada PR con su
  test, sin "2.758 líneas y una permiso nuevo" etiquetado como 0.4.1.

---

## 6. Defectos verificados (con `archivo:línea`)

> Todos verificados leyendo el código. Prioriza por severidad y por **coste de arreglar más
> tarde**.

### 6.1 Motor de detección

| ID | Sev | Defecto | Evidencia |
|---|---|---|---|
| DET-01 | **CRÍTICA** | La captura de red **excluye el tipo `image`** y descarta toda petición con `tabId < 0`. Las imágenes dentro de iframes cross-origin, de hojas de estilo cross-origin, o servidas por el Service Worker de la página son **invisibles**. | `background.js:238,298-306` |
| DET-02 | **CRÍTICA** | El `MutationObserver` de re-escaneo **nunca observa `document`** — solo shadow roots abiertos y documentos de iframe same-origin. En cualquier página sin esos nodos, el observer **no observa nada**: infinite scroll, SPAs, feeds virtualizados → **cero re-escaneo automático**. | `content.js:927-937` |
| DET-03 | **CRÍTICA** | `notify()` recalcula tamaños con `perfSizeBytes()` por cada ítem → materializa `getEntriesByType("resource")` y hace scan O(entries) **por ítem**, cada 350 ms. A 4.000 ítems son ~8M comparaciones de string cada 350 ms. | `content.js:181-193, 254-269` |
| DET-04 | **ALTA** | `notify()` envía el **store completo** por IPC, incluyendo data-URIs de canvas (MB) y miniaturas a resolución nativa, y el SW lo re-serializa a `storage.session` en cada request de red. | `content.js:191,247`; `background.js:167,340,807` |
| DET-05 | **ALTA** | Cualquier atributo `data-*` de un `<img>` cuyo valor empiece por `/`, `./`, `../`, `http` o `//` se convierte en **imagen falsa** con `ext:"jpg"`. `data-testid="/x"` → falso positivo. Sin filtro de extensión ni de longitud. | `content.js:409` |
| DET-06 | **ALTA** | `toDataURL` sobre **todo canvas ≥100×100 en cada escaneo**. (a) canvas WebGL sin `preserveDrawingBuffer` → PNG en blanco; (b) canvas tainted lanza a un `catch {}` **vacío**; (c) cada recaptura produce data-URL distinta → **clave nueva** → crecimiento hasta el tope de 4.000, tras el cual **todo el medio real se descarta**. | `content.js:429-438` |
| DET-07 | **ALTA** | `blob:` de `<video>` se guarda como ítem descargable con `ext:"mp4"`, `domain:""`, y **nunca es resoluble**. `captureVideoThumb` crea un canvas a resolución nativa y carga un segundo `<video>` con el mismo `blob:` que nunca cargará → **8 s de timeout por vídeo por escaneo**. | `content.js:858-871, 275-323` |
| DET-08 | **ALTA** | `detectMagic` clasifica **AVIF, HEIC, M4A, CMAF y segmentos `.m4s`** como `mp4`, porque `ftyp` es un campo de *brand*, no de tipo. Contradice las propias tablas de extensiones que listan `avif`/`heic` como imagen. | `media-core.js:76` vs `:11`, `content.js:10` |
| DET-09 | **ALTA** | El parser DASH está roto en tres puntos: (a) `m[0]` es solo el tag de apertura `<Representation>`, así que **los `SegmentTemplate` a nivel Representation nunca se parsean**; (b) si no hay template, `tpl` es `null` y `tpl.media` lanza `TypeError` → **falla el manifest DASH completo**; (c) `$RepresentationID$` se sustituye por **`bandwidth`**, no por `id`. Además `SegmentTimeline` no se parsea y `mediaPresentationDuration` no matchea. | `media-core.js:169-199, 107, 185-203` |
| DET-10 | **ALTA** | La base URL de HLS se deriva con `url.lastIndexOf("/")` sobre la URL **completa**: un manifest con query (`?p=a/b`) produce una base basura → todos los segmentos dan 404. `<base href>` se ignora en todas partes. | `media-core.js:234, 141` |
| DET-11 | **ALTA** | Dos implementaciones de `extOf` que **discrepan** (`{2,5}` vs `+`, con/sin query params), pese a que `media-core.js` se autodeclara "ÚNICA FUENTE DE VERDAD". Y `classify()` hace regex sobre la **URL completa**: `?poster=https://…/p.jpg` convierte un vídeo en imagen. `.ts` clasifica **TypeScript** como vídeo. | `content.js:93-118,16-21`; `media-core.js:24-31,17-22`; `background.js:247-252` |
| DET-12 | **ESTRUCTURAL** | **No existe hook de `URL.createObjectURL`.** Es la única técnica fiable para correlacionar `blob:` ↔ URL de red. Hoy se **adivina**: se toma el primer vídeo HTTP no-init en orden de inserción. | ausente en todo `src/`; adivinanza en `content.js:1790-1814` |
| DET-13 | **ALTA** | **Las fuentes no se descubren nunca**: `@font-face` es un `CSSFontFaceRule` (tipo 5), no está en `type===1` ni tiene `.cssRules`. Los `@import` tampoco (exponen `.styleSheet`). El harvest de CSSOM solo recorre `document.styleSheets`, **nunca shadow roots ni iframes**, pese a que `allRoots()` existe. | `content.js:701-731` vs `:378` |
| DET-14 | MEDIA | Heurística de `srcset` demasiado laxa: `val.includes("w ")` matchea cualquier string con coma que contenga `w`+espacio. Y `parseSrcset` parte por comas, corrompiendo data-URIs y URLs con coma. | `content.js:532-534, 150-156` |
| DET-15 | MEDIA | URLs relativas dentro de iframes same-origin se resuelven contra el documento **top**, no contra el iframe → URL **incorrecta** y 404 al descargar. | `content.js:143-147, 378-388` |
| DET-16 | MEDIA | La heurística `/init/i` marca como init-segmento cualquier URL que contenga la subcadena `init` — incluidos `initial-setup.mp4` o `product-init.mp4`. Se **descartan vídeos reales** y contradice el claim de "cero lógica específica de plataforma". | `content.js:1804`; `background.js:311-313` |
| DET-17 | MEDIA | `observedRoots` es un `Set` de referencias fuertes a `ShadowRoot`/`Document` **nunca podado**: cada ruta SPA y cada navegación de iframe same-origin filtra una entrada + un observer vivo. | `content.js:929-936` |
| DET-18 | ALTA | Debounce starvation: `attributeFilter` incluye `style`, así que cualquier página que mute `style` a ≥1,25 Hz (carruseles, barras de progreso de vídeo, CSS-in-JS) **resetea el timer para siempre** y `fullScan()` no se ejecuta nunca más. | `content.js:924, 1000-1012` |
| DET-19 | ALTA | El store tiene tope duro de 4.000 **sin evicción**: cuando se llena, se descartan los más nuevos → una página ruidosa **degrada permanentemente** la detección. meanwhile `tab.items` en el SW hace `shift()` (evicta los viejos). **Políticas divergentes.** | `content.js:213`; `background.js:333` |
| DET-20 | BAJA | `scanTotal`/`scanDone` son globals de módulo escritos por N cadenas concurrentes, y `fullScan` **fabrica** progreso. El contador "Analizando X de Y" del panel es decorativo. | `content.js:638-661, 958, 970` |

**Gaps de detección vs. estado del arte 2026 — ausentes por completo:**

| Técnica ausente | Impacto |
|---|---|
| `URL.createObjectURL` hook | `blob:` no resoluble (es la técnica central de 2024-2026) |
| `ManagedMediaSource` | `recorder-main.js:106` solo comprueba `MediaSource` → los players modernos (video.js, Shaka) evaden el recorder |
| `WebCodecs` (`VideoDecoder`/`AudioDecoder`) | invisible — es el stack de reproducción dominante en short-form |
| `MediaStream` / WebRTC | `getDisplayMedia` y streams recibidos no detectables |
| `ServiceWorker` / CacheStorage / IndexedDB | activo **excluido** por `tabId < 0`; las PWAs offline-first son un punto ciego |
| `onHeadersReceived` / `onResponseStarted` | sin `Content-Type`, sin `Content-Range`, sin `Accept-Ranges` → **por eso DET/DL-01 tiene que hacer GET completos** |
| `PerformanceObserver` para `resource` | solo se consulta bajo demanda; sin feed vivo |
| `link[rel=preload\|prefetch]` como fuente declarada | solo indirecto vía Resource Timing |
| Subtítulos / `<track>` / WebVTT | no soportado |
| `mask-image`, `border-image`, `list-style-image`, `content:url()`, `feImage`, CSS Paint | invisibles |

### 6.2 Motor de descarga

| ID | Sev | Defecto | Evidencia |
|---|---|---|---|
| DL-01 | **CRÍTICA** | `enrichSize` nivel 1 hace **`fetch()` + `res.blob()` del archivo entero** — 8 workers concurrentes — **antes de intentar `HEAD`**. Un vídeo de 2 GB se descarga entero a RAM solo para pintar "2.0 GB". Y el camino `onBeforeRequest` (el más caliente) **no tiene tope de concurrencia**. El comentario del código afirma que HEAD va primero: **es falso**. | `background.js:376-389, 338, 494` |
| DL-02 | **CRÍTICA** | **Cero sanitización de filenames en toda la extensión.** El único sanitizer del repo está en `recorder.rs:189` y aplica **solo a grabaciones**, no a descargas. No hay `Content-Disposition` (ni `filename*` RFC 5987/8187), no hay normalización Unicode, no hay nombres reservados de Windows, no hay límite de longitud. | `recorder.rs:189` vs ausencia en `src/` |
| DL-03 | **CRÍTICA** | `urlBasename()` hace `split("/")` **antes** de `decodeURIComponent`, así que un separador percent-encoded sobrevive al nombre. `<img src="https://x/a%2F..%2F..%2Fstartup.lnk">` → `downloads.download({filename: "a/../../startup.lnk"})`. Chrome sanea *el resultado*, pero: (a) los **subdirectorios** relativos son legales → la página crea árboles en `~/Downloads`; (b) en ZIP los nombres van a `zip.file()` **sin sanear** → **zip-slip**; (c) la UI y el historial reportan el nombre **sin sanear** → discrepancia permanente entre lo prometido y lo escrito. | `background.js:280-287`; `panel.js:290-297, 3762` |
| DL-04 | **ALTA** | Se **descarta siempre** el nombre que propone el servidor. En las rutas con Blob/data-URL, Chrome ve una URL sintética. El `[id]` de los ficheros reales del usuario viene del template de yt-dlp, no del motor. | `background.js` (0 ocurrencias de `content-disposition` en `src/`) |
| DL-05 | **ALTA** | `conflictAction:"uniquify"` en **todas** las rutas → Chrome añade `(1)`, `(2)` en silencio. Sin listener `onDeterminingFilename`, la extensión **nunca se entera del nombre final**. La UI sigue diciendo `video.mp4`. Descargar 20 ítems con el mismo basename desde CDNs distintos produce 20 ficheros numerados sin aviso. | `background.js:729,913,1094,1112,1161,1642`; `panel.js` (12 call sites) |
| DL-06 | **ALTA** | **Colisión de IDs de reglas DNR**: el hash de la URL cae en `7001..7999` (999 slots) y el host en 199. Con 8 descargas en vuelo el birthday collision ≈3 % por lote. En colisión, una descarga **borra la regla Referer de otra** → 403 en un archivo diferente, y su `finally` borra la del otro. | `background.js:27-31, 78-82, 37-38, 695` |
| DL-07 | **ALTA** | Se usa `updateDynamicRules`, que **persiste entre sesiones del navegador y upgrades de la extensión**, cuando la intención documentada es "regla EFÍMERA". Cualquier fuga deja un `Referer` **obsoleto inyectado permanentemente**. No hay barrido en `onInstalled`; `getDynamicRules()` no se llama nunca. | `background.js:37, 64, 70-72, 88, 115` |
| DL-08 | **ALTA** | La **URL cruda** se usa como `urlFilter` de DNR, que es un **lenguaje de patrón** (`* | ^ : ? - \`). Una `?` (toda URL firmada) es wildcard; una `|` legal en un query parte el filtro en un **OR de dos patrones** → la regla casa con URLs no pretendidas y les manda el `Referer` de la página. | `background.js:49, 100` |
| DL-09 | **CRÍTICA** | **No hay cookies en ninguna capa.** `cookies` **no está en los permisos**; `chrome.cookies` no se llama nunca; `document.cookie` no se lee nunca. El fallback **`capture-in-page`** se **documenta** como "capturar el recurso DESDE la página (con cookies + Referer de sesión)" pero **delega de vuelta al service worker** → los cookies `HttpOnly` son inalcanzables en toda ruta que no sea `chrome.downloads`. | `content.js:2058-2069, 1206-1208`; `panel.js:3166-3189`; `manifest.json:7-17` |
| DL-10 | **ALTA** | El host nativo usa `ureq` con `user_agent("operant/0.4.0")`, **sin cookies, sin Referer, sin timeout en el check de updates**. Como DNR solo afecta al navegador, `dash-merge`/`extract-mp3`/`convert-webm` **fallan exactamente en los CDNs anti-hotlink** que el resto del motor existe para sortear. Y el host nunca recibe el `filename` que el panel envía. | `tools.rs:12, 162-181, 268-283`; `main.rs:164-175` |
| DL-11 | **ALTA** | **Nada se transmite.** `arrayBuffer()` → `new Uint8Array(buf)` (**copia 2×**) → string latin1 → `btoa` (**+33 %**). Un HLS de 128 MB pasa a ~**560 MB de pico en el SW**, que tiene presupuesto de renderer mucho menor. `maxBytes` se comprueba **después** de la asignación. | `background.js:675-697, 1611-1641` |
| DL-12 | **ALTA** | `background.js:1648` hace `String.fromCharCode(...bytes.subarray(0, 3MB))` — hasta **3.194.464 argumentos** — que es **exactamente** el fallo que el comentario dos líneas arriba documenta y que el helper de chunks evita. Se ejecuta **después** de que `downloads.download` ya tuviera éxito → **reporta fallo de una descarga completada**, y por encima el chequeo `!headAscii.includes("soun")` es **caricatura** en TS (no existe `soun` en MPEG-TS → **toda descarga TS reporta "sin pista de audio"**). | `background.js:1634-1649` |
| DL-13 | **CRÍTICA** | Las descargas que corren en el SW no son **invulnerables al cierre del service worker**: no hay `chrome.alarms`, ni documento offscreen, ni `Port` de keepalive, ni checkpoint en `storage.session`. Cuando el SW muere a mitad de una descarga HLS: el `sendResponse` pendiente nunca dispara, **los `finally` no corren** (reglas DNR filtradas + **claves AES-128 filtradas**), y el usuario recibe **cero bytes y un fallo inexplicado**. | `background.js` (ausencia); `hls-fast.js:241` |
| DL-14 | **ALTA** | **La cola vive en el panel** (`dlJobs = new Map()` en el heap de la página, con los `ArrayBuffer` de los chunks). Cerrar el panel, recargar o reiniciar la extensión **destruye todos los jobs en vuelo y todos los bytes descargados**, sin mensaje. Un job de 4 GB son 4 GB de heap de panel que evaporan. | `panel.js:3400-3419, 3659-3660` |
| DL-15 | MEDIA | `DL_MAX_IN_FLIGHT = 8` es **código muerto**: el bucle interno es estrictamente serial (`await`), así que nunca se supera 1 request en vuelo por job. La concurrencia real son 3–8 jobs, no chunks. | `panel.js:3402, 3583-3602` |
| DL-16 | **ALTA** | **Cero retries** en la cola de chunks. Un reset TCP en cualquier chunk de 4 MB marca el job como `failed` → cae al fallback → **re-descarga el archivo entero** en el SW. Un job al 90 % y reanudable se descarta. | `panel.js:3651-3677, 3611-3634` |
| DL-17 | **ALTA** | No se valida `Content-Range`. Si el servidor **ignora `Range`** y devuelve `200` con el cuerpo entero, el archivo se ensambla con **rebanadas desalineadas** y se reporta **`status:"done"`**. Sin verificación de tamaño, sin checksum, sin detección de huecos. | `panel.js:3657-3660, 3679-3699` |
| DL-18 | ALTA | Los `blob:` se revocan con un timer de **reloj de pared iniciado antes de que la escritura termine** → `ERR_FILE_NOT_FOUND` en descargas grandes. `lastError` se lee en **un solo** sitio de todo el repo; los ~10 callbacks de `downloads.search` lo ignoran. | `background.js:1477`; callbacks en `:748,753,761`, `panel.js:2936-2947` |
| DL-19 | MEDIA | `media-updated` **confía en `msg.tabId`** sin validar contra `sender` → un content script puede inyectar hasta 4.000 ítems en el estado de una pestaña arbitraria y hacer que se los difunda a todos los paneles. | `background.js:800-818` |
| DL-20 | **ALTA** | El merge de `media-updated` **sobrescribe los tamaños enriquecidos** con `null` del content script en cada `notify()` → `enrichMissing` vuelve a hacer GET del cuerpo entero → siguiente `notify()` los nullea otra vez. **Bucle infinito de GET** en páginas con carga lenta. | `background.js:803-805, 456` |
| DL-21 | ALTA | La navegación SPA (`onHistoryStateUpdated`) **no limpia `tab.items`** del SW (solo la navegación completa sí). El siguiente `media-updated` **fusiona encima** → el panel muestra la **unión de todas las rutas visitadas**. Con carrera además: el content script saliente puede emitir después del borrado. | `background.js:203-235` |
| DL-22 | BAJA | Sin `chrome.downloads.cancel`/`erase`, sin listener `onDeterminingFilename`, sin barrido de `.crdownload` huérfanos, sin `INTERRUPT_REASON` tipificado (`NETWORK_FAILED` vs `FILE_NO_SPACE` vs `USER_CANCELED` se muestran como el string crudo). | `background.js:736-768` |

### 6.3 Motor HLS (`src/shared/hls-fast.js`)

> **El modo de fallo dominante de este motor no es un error: es la corrupción silenciosa.**

| ID | Sev | Defecto | Evidencia |
|---|---|---|---|
| HLS-01 | **CRÍTICA** | `EXT-X-DISCONTINUITY` **no se maneja**; todo tag desconocido se descarta con `continue`. Los `EXT-X-MAP` de cada periodo se **hoistean todos a la cabeza, en orden de finalización de descarga** (nondeterminista), y si el MAP es el mismo se **deduplica por URL** descartando los siguientes. Resultado: concatenación binaria con DTS no monótonos y `trex` del periodo equivocado → **archivo irreproducible, sin error**. | `hls-fast.js:203, 343-347, 492-496` |
| HLS-02 | **CRÍTICA** | Byteranges en live: `nextOffsetByUrl` es un acumulador **por parseo**, y el poller re-parsea la playlist entera cada `TARGETDURATION/2` → los segmentos con offset implícito **siempre calculan offset 0**. El `Range` es **válido**, la longitud **coincide**, y se concatenan **bytes equivocados sin error**. | `hls-fast.js:138, 210, 661-664` |
| HLS-03 | **ALTA** | `EXT-X-MAP` con `BYTERANGE="<len>"` sin offset → `{offset: null}` → la interpolación produce `Range: bytes=null-99`. Además el regex exige la forma **con comillas** (`BYTERANGE=1000@500` es legal y no matchea). | `hls-fast.js:196-199, 301, 416` |
| HLS-04 | **ALTA** | El parser de atributos de `#EXT-X-KEY` **no es quote-aware**: `URI="https://k/x?a=1,2"` se corta en la coma → **404 en la clave** → descarga muerta. `IV` igual. | `hls-fast.js:174-177` |
| HLS-05 | ALTA | La **descarga de la clave** no pasa por el wrapper de credenciales: los segmentos reintentan con `credentials:"omit"` ante fallo CORS, la clave **no** → un endpoint de clave sin `ACAC` falla duro. `keyCache` no tiene cota y **el panel nunca lo limpia** (solo el SW). | `hls-fast.js:243-250 vs 375-384, 767-769` |
| HLS-06 | **ALTA** | El container se decide con `sniffContainer(hasMap, firstBytes)` donde `firstBytes` es **el primer segmento en terminar**, no el segmento 0. Con concurrencia 6, un `moof` gana → se emite fMP4 como `video/mp2t` y se nombra `.ts`. **Nondeterminista: la misma URL puede pasar o fallar.** | `hls-fast.js:452, 325-332, 496` |
| HLS-07 | ALTA | El "sniff" de audio es `asciiOf(initBuf).includes("soun")` sobre el init **entero** y **sin cota de tamaño**. Falso positivo → se entrega un archivo **sin audio** como si fuera vídeo válido. | `hls-fast.js:406-422` |
| HLS-08 | MEDIA | Un `METHOD` desconocido en `#EXT-X-KEY` deja `currentKey` **sin cambiar** (la cadena `if/else if` no tiene `else`) → se descarga con la clave equivocada y se reporta `encrypted: true`. Un `SAMPLE-AES` que aparece **a mitad de live** lanza, el error se traga porque `done > 0`, y el bucle **reintenta eternamente sin contador de estancamiento**. | `hls-fast.js:179-188, 719-730` |
| HLS-09 | MEDIA | En live: toda la grabación vive en un `Map<seq, Uint8Array>` sin drenar, capeado a 2 GB, y luego `new Blob(parts)` **copia todo otra vez** → pico ≈2×. Un reset de `MEDIA-SEQUENCE` trunca la grabación y se reporta **con éxito**. `requireAudio` **no se aplica en live** → se entrega un archivo mudo como válido. | `hls-fast.js:563, 612-619, 740-750, 519-534, 703-711` |
| HLS-10 | MEDIA | Backoff **lineal** `400*(attempt+1)`, `retries=2`, **sin jitter**, sin `Retry-After`. La **playlist en live tiene 0 reintentos** (los segmentos tienen 3). Abort no cancela los fetch en vuelo (`signal` nunca se pasa a `fetchImpl`). | `hls-fast.js:298-321, 306, 661, 727-730` |

### 6.4 Host nativo (Rust) y grabador

| ID | Sev | Defecto | Evidencia |
|---|---|---|---|
| SEC-01 | **CRÍTICA** | 🔴 **Clave privada RSA completa commiteada** en `native-host/key_info.json` (`privateKeyPem`, 1.704 chars, presente en `HEAD`). Como `manifest.json` fija la extensión con `key`, **cualquiera con esa clave puede publicar actualizaciones** de la extensión instalada. Hay que **rotarla y purgarla del historial**. | `native-host/key_info.json:4`; `src/manifest.json:5` |
| NAT-01 | **CRÍTICA** | `stderr` se **pipea pero nunca se drena** en `ffmpeg_ops.rs` y `ytdl.rs` (solo se lee `stdout`). ffmpeg con loglevel `info` emite ~1 línea por segmento HLS → a >64 KB de stderr **ffmpeg se bloquea en `write()`**, stdout enmudece, el reader se bloquea → **no hay `ffmpeg-done` ni `ffmpeg-error`, la UI queda en "Procesando…" para siempre, dos procesos zombis**. yt-dlp escribe la mayoría de sus diagnósticos a stderr. | `ffmpeg_ops.rs:232-265`; `ytdl.rs:115-130` |
| NAT-02 | **CRÍTICA** | `dash-merge` **ignora `videoSegments`/`audioSegments`**: el SW envía init + todos los segmentos, el host lee solo `videoUrl` (un único fragmento, a menudo el **init** de ~800 B) y **reporta éxito** sobre un vídeo de ~1 KB. Además `looks_like_real_media()` existe pero **no se aplica a `ffmpeg_ops`** (solo al recorder). Esto es una **regresión funcional contra el host Python que reemplazó** — el Python concatenaba los segmentos. | `ffmpeg_ops.rs:128-164`; `background.js:124-132, 961-972`; `native-host/operant_host.py:567-592` |
| NAT-03 | **ALTA** | El protocolo nativo **no tiene correlation IDs ni versionado**. El panel enruta **todos** los mensajes nativos a **una única máquina de estados global**: un `ffmpeg-op` concurrente mientras se ensambla una grabación se anuncia como **"Grabación lista"** y limpia el estado de grabación. | `main.rs` (sin ids); `panel.js:4720-4794` |
| NAT-04 | **ALTA** | Sin verificación de integridad de los binarios que descarga y ejecuta: **no hay SHA-256 pinado, ni Authenticode, ni verificación de firma**. Fuentes: `github.com/yt-dlp` y `www.gyan.dev`. Un CDN comprometido = **ejecución arbitraria como el usuario, lanzada por el navegador**. Además escribe al path final **sin `.part` + rename atómico**, así que una interrupción deja un ejecutable truncado. | `tools.rs:319-324, 10-11, 283, 361` |
| NAT-05 | ALTA | `std::mem::forget(tempdir)` deja los temporales de grabación **para siempre**: el guard de limpieza nunca corre si el host muere (que pasa en cada cierre de pestaña / recarga de extensión, porque el bucle principal sale con EOF de stdin). Directorios `operant-rec-*` multi-GB se acumulan sin barrido. | `recorder.rs:37-42, 267-275` |
| NAT-06 | ALTA | `panic = "abort"` + 12 `unwrap()` + un `Mutex` de stdout **compartido por todos los hilos**: cualquier panic envenena el mutex y el siguiente `unwrap()` **aborta el proceso**, matando todos los jobs y todas las grabaciones. `recorder.rs:72` **mantiene el mutex de sesiones** a través de base64-decode + open + write → un disco lento serializa todo. `Regex::new` se compila dentro del hot path. | `main.rs:126,146`; `protocol.rs:21`; `recorder.rs:58,72,133,157,189`; `ytdl.rs:49,133`; `Cargo.toml:30` |
| NAT-07 | MEDIA | Argumentos de ffmpeg con problemas reales: `hls-dash` **sin `-map`** (con dos inputs el valor por defecto gana e ignora `audioUrl`); `convert-webm` usa `libvpx` (**VP8**, obsoleto → `libvpx-vp9`/`libsvtav1`); `resize-50` sin truncar a par → **fallo duro con dimensiones impares**; `-q:v` no es el control de calidad de libwebp; `crf` sin clampar; `-map` ausente también en el grabador. `output_dir()` hardcodea `%USERPROFILE%\Downloads\Operant` en vez de `SHGetKnownFolderPath(FOLDERID_Downloads)` → rompe con OneDrive Known-Folder Move. | `ffmpeg_ops.rs:165-232`; `recorder.rs:218-228`; `tools.rs:33-44` |
| NAT-08 | MEDIA | La generación de salida del grabador está **hardcodeada a `.mp4` con `-c copy`** → todo player MSE que use **WebM/VP8** falla con *"Could not find tag for codec vp8"*. Y si solo se capturó vídeo, se entrega un **MP4 mudo como éxito**. | `recorder.rs:198, 218-228` |
| NAT-09 | MEDIA | `ping` se maneja **sincrónicamente** en el bucle principal y ejecuta **2 spawns de proceso + un HEAD a GitHub sin timeout** → **bloquea todos los comandos**, incluidos los chunks de grabación, que son latency-critical. | `main.rs:98-103`; `tools.rs:114,125,161-181` |
| REC-01 | **ALTA** | 🔴 El puente de grabación se autentica con `REC_EPOCH = "r2"`, un **constante público** duplicado en dos ficheros y **expuesto en `window`**. Cualquier página puede hacer `postMessage` y: (a) **destruir una grabación en curso**; (b) **inyectar bytes elegidos por el atacante** vía `track-chunk` → **escritura arbitraria en disco** (DoS de relleno); (c) forzar la parada prematura con un fichero elegido; (d) simular el fallo honesto de DRM. | `recorder-main.js:25,34-35,224-228`; `content.js:1183-1189`; `background.js:1515-1531` |
| REC-02 | ALTA | `window.__operantRecorderInstalled = true` se fija **antes** de comprobar si `MediaSource` existe (3 líneas más abajo) → en plataformas no soportadas el usuario ve "grabación disponible" en verde y solo se entera al parar. | `recorder-main.js:32-35` vs `:106` |
| REC-03 | **ALTA** | Los chunks **no tienen detección de huecos**: el índice se calcula y se descarta, el host **no lo lee**, el SW **no lo reenvía** (`background.js:1515-1519` solo manda `track` y `data`). Un chunk perdido deja un **agujero sin error**; `ffmpeg -c copy` lo emite con normalidad. Y solo se envía **el último** init,los anteriores los anteriores. Si el `session` aún no ha llegado del host, **cada chunk se descarta en silencio**. | `recorder-main.js:198-213`; `background.js:1515-1519,1812-1814`; `recorder.rs:71-129` |
| REC-04 | **ALTA** | Memoria del grabador **ilimitada**: `state.sources` nunca se poda y `getOrCreateSource` es un **scan O(n) lineal** → ningún `MediaSource` puede ser recolectado. Tras parar, los buffers de **todos** los sources distintos del elegido **quedan retenidos** en la pestaña para siempre. Sin tope de bytes ni rollover. Las pistas se keyed por `audio|video`, así que **dos SourceBuffers de vídeo se intercalan en un mismo fichero**. | `recorder-main.js:42,76-91,157-173,184-222` |
| SEC-02 | ALTA | Cualquier script de la página puede hacer `document.dispatchEvent(new CustomEvent("__operant-shutdown"))` → `contextDead = true` permanente: el scanner sigue gastando CPU y toda la UI desaparece. | `content.js:83-91` |
| SEC-03 | MEDIA | No hay `onDeterminingFilename`, no hay saneo de `Referer` de vuelta, y el `Referer` se toma de `sender.tab?.url` / `msg.pageUrl` **sin validar** → cualquier página puede fijar un `Referer` arbitrario en requests originados por la extensión. No se strippea `Set-Cookie` (no hay acción de `responseHeaders`), así que un download puede **mutar el cookie jar** del perfil. | `background.js:33-59, 405, 681, 1062` |

### 6.5 Ingeniería: tests, CI, release, repositorio

| ID | Sev | Defecto | Evidencia |
|---|---|---|---|
| INF-01 | **CRÍTICA** | **No existe ninguna CI.** 0 ficheros de config en **ninguno** de los 32 commits. Todos los comandos son manuales y developer-local. Nada impide que el diff de 2.758 líneas llegue a producción roto. | ausencia de `.github/`, `.gitlab-ci`, etc. |
| INF-02 | **CRÍTICA** | **Cobertura real ≈ 0%** de lo que importa: **0/29** handlers del service worker están cubiertos (incluidos **todos** los paths de descarga), `hls-fast.js` **0%** (la decifrado AES-128 no tiene **ningún** test), `media-core.js` **0%** (los parsers HLS/DASH, `detectMagic`, el box walk MP4, `classifyDownload`), `recorder-main.js` **0%**, `dl-indicator.js` **0%**. Rust: **0 `#[test]`**. `cargo test` compilaría 7 módulos y ejecutaría 0 tests, saliendo en verde. | `background.js:771-1682`; ausencia de tests |
| INF-03 | **CRÍTICA** | Los tests **pasan mientras están rotos**: `check(true, …)` incondicional; un `warn:true` hardcodeado que hace `p4-hls-demo` **imposible que falle**; `[].every(...) === true` sobre arrays vacíos — bug **preservado como evidencia**: `tests/results/A2-dl-queue.json` registra `"verdict":"PASS"` con `"3 jobs creados (0)"` fallando y los otros 3 checks **pasando sobre un conjunto vacío**. `10-native-host` es **infalsable**: pasa tanto si responde `pong` como si no está instalado. | `run-panel-audit.js:129, 150-155`; `run-verification.js:404, 493`; `tests/results/A2-dl-queue.json` |
| INF-04 | **ALTA** | Los artefactos de `tests/results/*.json` están **gitignored**, así que **no hay baseline de regresión**. Además `run-panel-audit.js` **nunca escribe JSON** (verificado en las 32 revisiones): los ficheros `A1/A2/A3-*.json` vienen de un harness **nunca commiteado**, y `A1-perf-panel.json` registra `"panel is not defined"`. El harness de auditoría **nunca descarga Chrome** (a diferencia de `run-verification.js`) → **`npm run test:audit` falla en un clone limpio**. | `.gitignore:10`; `git log --all -S "A1-perf-panel"` → 0 |
| INF-05 | **ALTA** | `.gitignore:4` tiene `*.zip`, que excluye `tests/fixtures/media/sample.zip`, que el caso 04 **asserta** → **test 04 falla en un clone limpio**. `npm run test:fixtures` no está encadenado ni documentado como prerrequisito. | `.gitignore:4`; `run-verification.js:276` |
| INF-06 | **ALTA** | **Cero linter, formatter, ni typechecker.** 0 de eslint/prettier/biome/tsconfig/rustfmt/clippy/`deny(warnings)`/`editorconfig`/`gitattributes`. Ya hay 3 avisos de CRLF/LF en `git diff`. Contradicción: `TESTING.md:317` afirma *"web-ext lint: 0 errores"*, lo cual **no es reproducible** (el comando no existe en ningún script). | ausencia; `git diff` |
| INF-07 | **ALTA** | **9 sitios con 4 valores de versión distintos**: `package.json` 0.4.1 · `src/manifest.json` 0.4.1 · **`package-lock.json` 0.4.0** · `Cargo.toml` 0.4.0 · `main.rs:39` `v0.4.0` · `tools.rs:12` UA `operant/0.4.0` · `operant_host.py:31` `operant/0.4` · el zip en `web-ext-artifacts/` 0.4.0 · `dist-firefox/manifest.json` **0.4.0 (obsoleto)**. **0 tags** de git para un "v0.4.0 initial public release". Sin CHANGELOG. | — |
| INF-08 | **ALTA** | El binario `native-host/operant-host.exe` (2.588.160 B) está **commiteado = 23,5 % de todos los bytes del repo**, está **sucio en el working tree**, y ya no corresponde al `src/` actual. Los artefactos de release deben salir de `cargo build` en CI, firmados, nunca de git. | `git ls-files -s`; `git status` |
| INF-09 | **ALTA** | Firefox: `manifest.json` declara `side_panel`, que **no existe en Gecko**; `chrome.sidePanel.setPanelBehavior` falla y se traga con `.catch(()=>{})`. **El punto de entrada principal de la extensión está roto en Firefox y el fallo está oculto.** `dist-firefox/` está obsoleto (le faltan `player.html` e `icons.js`), `build-firefox.mjs` **borra `manifest.key`** (→ el XPI tiene **distinto extension ID** que el host nativo compartido), y **ningún test** carga el build de Firefox. Cero shims `browser.*`. | `manifest.json:25-27`; `background.js:176`; `build-firefox.mjs:22` |
| INF-10 | **ALTA** | `activeTab` está declarado y **tiene 0 referencias en todo `src/`** (el README lo justifica para re-scan, que usa `tabs.sendMessage` sobre una pestaña ya concedida). Es una violación de mínimo privilegio que **Chrome Web Store rechazaría**. No hay `optional_host_permissions`. | `manifest.json:9`; grep `activeTab` → 0 |
| INF-11 | **ALTA** | **Ausentes, y bloqueantes para publicación**: política de privacidad (CWS y AMO la exigen), `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, ADR, documento de arquitectura, contrato de los 29 mensajes del SW + 8 del CS + 12 ops nativas, `minimum_chrome_version` (el código usa **CSS Anchor Positioning**, `position-visibility: anchors-visible`, `Array.prototype.at`, `??=` → usuarios con Chrome <125 obtienen un overlay degradado **en silencio**), `_locales/`, capturas para la tienda, y `data_collection_permissions` de Gecko declara `"required":["none"]"`, lo cual es **probablemente falso**: `upload-tmp` hace POST a `litterbox.catbox.moe` y el popover enlaza a **6 motores de reverse image search**. | `manifest.json:64-74`; `background.js:1393-1437` |
| INF-12 | MEDIA | Documentación **desalineada de la realidad**: `TESTING.md` (695 líneas) es un cuaderno de laboratorio cronológico, no un plan de tests. Afirma *"Con el host NO registrado, connectNative falla limpio"* mientras el artefacto commiteado registra **"conectado y respondiendo pong"**. El badge del README dice "10/10 PASS" pero `--public` **falla siempre** (`p1-unsplash` → 403 anti-bot → `exit(1)`). El árbol del README omite `icons.js`, `player.html` y `ffmpeg_ops.rs`. Afirma *"media real generada por ffmpeg"* en `fixtures-server.js`, que no invoca ffmpeg. Y `tabCapture` aparece como plan, pero **no está en los permisos**. | `TESTING.md:39,64,21,72`; `README.md:11,77-94` |
| INF-13 | MEDIA | `@ffmpeg/core` + `@ffmpeg/ffmpeg` están como **`dependencies` de runtime** (peso muerto en el grafo de la extensión) con **0 usos** en `src/`. `run-verification.js` importa `@puppeteer/browsers`, una **dependencia transitiva no declarada**. Faltan los ficheros de licencia de los vendors (1,2 MB de BSD/Apache re-distribuidos sin atribución bajo GPL-3). `tests/fixtures/pages/photos.html` está trackeado pero **no lo genera** `generate-fixtures.js`. | `package.json`; `src/vendor/*.LICENSE.txt` ausente |
| INF-14 | BAJA | El `ManifestObserver` de re-escaneo escribe `style` inline en sus propios nodos **dentro del árbol observado** (`attributeFilter` incluye `style`) → se auto-dispara; el único listener de `document.documentElement` cierra el popover (`content.js:2312`), así que **escribir la posición del popover lo destruye** en touch/teclado. Y `shutdownOperantUI()` quita el DOM pero **no desconecta ninguno** de los ~12 listeners ni limpia los timers → **cada recarga de la extensión duplica permanentemente el coste de escaneo** de las pestañas abiertas (el SW re-inyecta el content script). | `content.js:2453-2466, 2312, 67-77`; `background.js:1713-1733` |

---

## 7. Lo que el producto **no tiene** (los gaps que más pesan)

Estos no son bugs. Son capacidades ausentes. Cada una es una decisión de diseño, y cada una es
la que explica por qué la extensión se siente como un prototipo en lugar de un producto.

| Ausente | Consecuencia |
|---|---|
| **Ninguna verdad de bytes antes del clic** | Toda la UI (filtros, contadores, "vídeo sin audio", badges de dimensiones, orden por calidad) se basa en regex de URL. Es la causa raíz de DET-05/07/08/11/16 y de la mitad de los falsos positivos. |
| **NingunaHEAD-first / detección de tamaño por headers** | Obliga a GET completos (DL-01) o a no saber el tamaño. Sin `onHeadersReceived` no hay `Content-Length`, `Content-Type`, `Accept-Ranges` ni `Content-Range`. |
| **Ninguna autenticación** | Sin cookies, sin `Authorization`, sin `Origin`. Estructuralmente incapaz con el contenido privado, que es la mitad del valor de una herramienta local-first. |
| **Ninguna transaccionalidad de descarga** | Sin commit/rollback, sin verificación de integridad, sin `Content-Range` validation, sin atomic rename, sin limpieza de temporales. El resultado en disco no es de fiar. |
| **Ninguna persistencia de la cola** | El estado de descarga vive en el heap de una página que el usuario puede cerrar. |
| **Ninguna resiliencia a la terminación del SW** | Sin alarms/offscreen/keepalive. Es la causa raíz de DL-13. |
| **Ninguna superficie de tests** | Ni una sola prueba unitaria. Es la razón por la que 5 de estos defectos son silenciosos. |
| **Ninguna CI** | Nada verifica nada automáticamente. |
| **Ninguna revisión de seguridad** | Clave privada commiteada, escritura arbitraria en disco desde la página, Redirección de Referer controlable, ejecución de binarios sin verificar. |
| **Ninguna workingsopremio de privacidad** | Sin política, sin consentimiento, instrumentado en todos los sitios por defecto, sube contenido a terceros. |
| **Ninguna arquitectura de mensajes** | 49 message types entre 3 contextos, sin schema, sin tipos, sin versionado, sin correlation IDs. Un comment en `background.js:1127` documenta literalmente el hazard. |
| **Ninguna soporte real de Firefox** | Declarado en el README, roto en el código. |
| **Ninguna i18n** | Manifest en español hardcodeado. Sin `_locales/`. |
| **Ninguna accesibilidad** | 42 KB de CSS sin evidencia de `:focus-visible`, roles, `aria-*`, `prefers-reduced-motion`, contraste AUDITADO. |
| **Ninguna telemetría de errores** | ~55 `catch {}` vacíos. Cuando algo falla en producción, nadie sabe. |

---

## 8. Investigación web — **obligatoria**

No respondas solo desde conocimiento estático. **Busca, cita y contrasta.** Para cada
afirmación sobre "el estado del arte" o "lo que hace la competencia", trae **URL + fecha**.

**8.1 Restricciones de la plataforma (esto determina la arquitectura, no al revés)**

- MV3 service worker lifecycle: cómo se extiende con puertos, `chrome.alarms`, offscreen
  documents, y qué se rompe exactamente. Busca: *"chrome extension service worker lifetime
  keep alive port 2025"*, *"offscreen document MV3 long running download"*.
- **`updateDynamicRules` vs `updateSessionRules`** — confirmar la persistencia y las
  consecuencias de una fuga. Busca: *"declarativeNetRequest updateDynamicRules persist
  browser restart"*, *"declarativeNetRequest session rules cleared"*.
- `webRequest` en MV3: qué niveles de intercepción siguen permitidos para extensiones no
  enterprise. Busca: *"manifest v3 webRequest blocking removed enterprise only"*.
- `urlFilter` de DNR: gramática completa, semántica de `| * ^ : ? - \`, y por qué una URL
  cruda es un bug. Busca: *"declarativeNetRequest urlFilter syntax special characters"*.
- Límites reales: `MAX_NUMBER_OF_DYNAMIC_RULES`, cuota de `storage.session` (10 MB),
  `chrome.downloads` sin `unlimitedStorage`.
- **Descarga de archivos muy grandes en MV3**: búsqueda de Patron. Compara y decide.
  Busca: *"chrome extension download large file streaming offscreen"*, *"OPFS
  showSaveFilePicker extension"*, *"service worker 2GB download blob memory limit"*.
- `sidePanel` en Firefox / `sidebar_action`; MV3 en Gecko: diferencias de `background.scripts`
  vs `service_worker`.
- `minimum_chrome_version` y APIs modernas usadas: CSS Anchor Positioning
  (`anchor-name`, `position-visibility: anchors-visible`), `ManagedMediaSource`, WebCodecs.

**8.2 Detección de medios (estado del arte 2026)**

- **Correlación `blob:` ↔ red**: interceptar `URL.createObjectURL` + `Response` +
  `fetch`. Busca: *"extract m3u8 from blob MediaSource chrome extension"*,
  *"blob url to network url mapping MSE"*,
  *"how to find real video url behind blob site"*.
- MSE: `SourceBuffer`, `ManagedMediaSource`, `timestampOffset`, `changeType`,
  `SourceBuffer.remove()`, discontinuidad y buffering ranges.
- **WebCodecs**: `VideoDecoder`/`AudioDecoder` como vector de captura en stacks modernes.
- **EME/DRM**: `MediaKeySystemAccess`, `navigator.requestMediaKeySystemAccess`,
  `encrypted` events. Busca: *"MediaKeySystemAccess detect encrypted video extension"*.
- Alternativas de CRC: **yt-dlp**, **streamlink**, **N_m3u8DL-RE**, **gallery-dl**, **youtube-dl
  extractors**. Extrae **qué plataformas/formatos cubren hoy** y qué están rotas.
- **HLS/DASH specs vigentes**: RFC 8216bis, DASH-IF, `EXT-X-DISCONTINUITY`,
  `EXT-X-SKIP`, `EXT-X-PART`, `EXT-X-PRELOAD-HINT`, CMAF `ftyp` brands, `SegmentTimeline`.
  Busca: *"HLS RFC8216 discontinuity fMP4 muxing"*, *"DASH SegmentTemplate
  SegmentTimeline parse"*, *"CMAF initialization segment brands list"*.
- Formatos: AVIF, HEIC, JXL, WebP, AV1, VVC/H266, HDR10/Dolby Vision, `EXT-X-KEY`
  `SAMPLE-AES`/`AES-128-LWR`, cifrados con Widevine/FairPlay (y por qué no son atacables).
- Atribución/percepción de recursos: por qué los sites usan `blob:` + MSE + anti-hotlink +
  tokens firmados; cómo lo resuelven las herramientas profesionales.

**8.3 Descarga fiable**

- **RFC 6266** `Content-Disposition`, **RFC 5987** `filename*` (y el bug de `filename*` que
  ignoran los navegadores), **RFC 8187**.
- Nombres de fichero seguros en Windows: reservados (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`,
  `LPT1-9`, y las formas `CON.png`), `MAX_PATH`, caracteres ilegales, NFC/NFD.
- **Zipslip**:History/CVE de extracción de ZIP traversal.
- Anti-hotlink: `Referer`/`Origin` spoofing, tokens firmados, CDN tokens (Cloudflare, Akamai,
  Bunny, Fastly), por qué `credentials: include` es la única palanca real.
- HTTP: `Range`, `206`, `Content-Range`, multipart ranges, `Accept-Ranges`,
  `If-Range`, `ETag`.
- Streaming a disco desde una extensión: `createWritable`, `showSaveFilePicker`, **OPFS**,
  y qué funciona realmente en un side panel.
- Resuming en un service worker que puede morir: strategies, checkpoints, reanudado.
- **yt-dlp**: estado actual 2026, drift de extractors, `--cookies-from-browser`,
  `--concurrent-fragments`, formatos AV1/Opus y el problema de `--merge-output-format mp4`.
- **FFmpeg 7/8**: `libvpx-vp9` vs `libvpx`, `libsvtav1`, `libaom-av1`, `-map`, `-copyts`,
  `-avoid_negative_ts`, `movflags`, muxing HLS/fMP4, passthrough HEVC/AV1/HDR.

**8.4 Competencia y profesionalización**

Analiza **a fondo** (features, arquitectura pública,y releases, política de permisos,
modelo de release) para extraer patrones:

- **Cohost Downloader**
- **Video DownloadHelper**
- **Downie** / **Permute**
- **Streamlink**
- **yt-dlp / youtube-dl**
- **Gallery-DL**
- **N_m3u8DL-RE**
- **4K Video Downloader**
- **Tab Save / SingleFile** (para persistencia y atomicidad de escritura)
- **ytmp3 / beets / fdupes / rmlint** (para estrategia de deduplicación y nombres)

**Pregunta clave para cada uno:** ¿cómo resuelve el problema de **blob:** ¿cómo resuelve
cookies/HTTPOnly? ¿cómo resuelve el nombre de fichero? ¿cómo escala la cola?

**8.5 Extensiones profesionales: modelo de referencia**

- Cómo se declara y justifica `<all_urls>` + `optional_host_permissions` en 2026.
- Privacy disclosure, consentimiento first-run, telemetría mínima.
- **Divulgación de vulnerabilidades**, SECURITY.md, bug bounty.
- Chrome Web Store: "single purpose", remote code, Data Disclosure, política de permisos.
- AMO: `data_collection_permissions`, revisión, firma.

**8.6 Testing de extensiones**

- `puppeteer` + Chrome for Testing: **pinning** de versión, `--load-extension`,Service
  workers, Web-ext / Playwright para Firefox.
- `web-ext lint` / `addons-linter` y qué reglas nuevas aplican.
- Testing de service workers: `chrome.storage.session`, reinicios, determinismo.
- Testing de descargas reales y verificación de bytes en disco.
- Property-based testing para parsers de manifests (¡HLS/DASH son el caso ideal!).
- Wycheproof-style vectors para la decifrado AES-128.
- Mutation testing en JS y Rust (`cargo-mutants`).

**8.7 Calidad, semver y seguridad de suministro**

- `web-ext` para builds reproducibles; por qué no se commitean binarios.
- SLSA / SBOM / `cargo audit` / `npm audit --audit-level=high` / Dependabot.
- Rotación de claves de extensión y purga de secretos del historial (`git filter-repo`,
  `gitleaks`, `trufflehog`).
- Firma de binarios nativos / notarización macOS.

---

## 9. Entregable: qué debes producir

**Cinco documentos. En Markdown. En español. Con citations de `archivo:línea` y URLs con fecha.**

### 9.1 `00-VERDICT.md` — Diagnóstico ejecutivo (máx. 2 páginas)
- **Veredicto en una frase** sobre el estado del producto.
- Una tabla con las **10 decisiones estructurales** equivocadas (no los 60 bugs).
  Para cada una: qué es, por qué importa, coste de arreglar ahora vs. en 6 meses.
- Clasificación honestă: ¿esto es un prototipo, una beta, o un producto? ¿Qué falta para
  ser publicable en CWS/AMO hoy?

### 9.2 `01-POR-QUE-FALLA.md` — Análisis causal (lo más importante)
**No enumeres bugs: explica las 8–12 causas raíz que los generan.**

Por ejemplo (verifica, no des por hecho):
- *"El sistema no tiene una noción de verdad"* → el content script adivina el tipo por regex
  y la verdad de bytes existe pero solo se consulta al hacer clic. De ahí salen ~8 defectos.
- *"El motor de descarga no tiene modelo transaccional"* → nada valida integridad, nada
  confirma el nombre final, nada limpia temporales. De ahí salen DL-01..DL-19.
- *"MV3 setrata como si fuera MV2"* → estado en memoria del SW, `stderr` sin drenar, sin
  alarms/offscreen, `updateDynamicRules` usado como si fuera de sesión.
- *"MV3 se trata como si el contenido fuera accesible"* → cero cookies, cero headers, y un
  bridge recorder con un "secreto" público.

Para cada causa raíz: **el patrón de fallo**, **por qué se-patrón se**(3–5 defectos
consecuentes), **el invariante que debería existir y no existe**, y **la decisión de diseño
correcta**.

### 9.3 `02-PLAN.md` — Plan por fases, con eje atómico
Estructura en **4–6 fases**. Para cada fase: objetivo, invariantes que se establecen,
cambios, **qué se rompe y cómo se mitiga**, cómo se verifica, **criterio de salida medible**.

Incluye **una tabla de dependencias** (qué bloquea a qué) y **la justificación del orden**.
Justifica el orden por coste-oportunidad, no por comodidad.

> **Regla de atomicidad:** cada PR debe ser (a) revisable, (b) verificable por un test,
> (c) invertible, (d) sin cambio de comportamiento observable salvo que el PR lo declare.
> Señala explícitamente **qué PRs son "comportamiento observable"** y requieren feature flag.

### 9.4 `03-TRACKED-BACKLOG.md` — Backlog completo
Una fila por cada defecto de §6 (y los que tú encuentres). Columnas:
`ID · severidad · capa · descripción de una línea · impacto observable para el usuario ·
esfuerzo (S/M/L) · riesgo · fase · dependencias · URL de referencia`

Ordena por severidad × probabilidad. **Marca explícitamente qué NO hay que arreglar**
(iceberg que no vale el esfuerzo) y por qué.

### 9.5 `04-TEST-PLAN.md` — Estrategia de calidad
- Qué se testea y con qué herramienta: **unit** (parsers, crypto, filenames, cola),
  **property-based** (manifests HLS/DASH), **integration** (Chrome real, Firefox real),
  **native** (`cargo test` + `pytest` sobre el companion Rust).
- Matriz: defect → test que lo habría detectado. **Objetivo explícito: qué % de los defectos
  de §6 habría atrapado cada suite.**
- Fixtures deterministas: media real generada por ffmpeg, CDNs simulados, casos de
  anti-hotlink, URLs firmadas que expiran, streams que cortan a mitad.
- Cómo testear un **service worker que puede morir** (esto es un problema de test en sí mismo).
- Definición de "coverage" que usaremos y por qué el coverage de líneas no sirve aquí.

---

## 10. Restricciones y criterios de calidad

**10.1 No hagas esto**

- **No reescribas el producto.** No propongas "rehacer la extensión desde cero". El código
  funciona en gran parte; el problema es la **falta de invariantes**, no la cantidad de
  código.
- **No propongas stacks.** No propongas React, TypeScript, WebAssembly, Rust→WASM, o
  reescribir el host. Si mencionas TS, es como *type-checking gradual* con `// @ts-check`,
  no como migración. Justifica Justifica cada decisión tecnológica con un beneficio concreto. con un beneficio concreto.
- **No inventes capacidades de la plataforma.** Si una API no existe o no está disponible
  para extensiones, dilo. Chrome MV3 eshos restrictivo; una propuesta que requiera
  capacidades de MV2 o de empresas es **inválida**.
- **No repitas los bugs como si fueran hallazgos.** §6 ya los tiene con evidencia. Tu trabajo
  es priorizar, causa-raíz y **secuenciar**.
- **No ignores los ya buenos.** Hay decisionesiquitáss excellent: `recorder.rs:244`
  `looks_like_real_media()` como puerta de integridad previa a la entrega;
  `hls-fast.js` AES-128 con IV de secuencia (RFC 8216 §5.2) correcto; `manifest.json`
  `data_collection_permissions` para Gecko; el aplanado a `createObjectURL` porque los MV3
  SW no lo tienen; `content.js` copiando el buffer **antes** de `appendBuffer` del player;
  sin `unsafe` innecesario y sin shell en todo el Rust. **Díselo y leveragearlo.**
- **No propongas features.** El objetivo es robustez/profesionalismo/atomicidad/calidad, no
  más superficie. Si algo es "bonito de tener", ponlo en "fuera de alcance".

**10.2 Sé concreto**

- Cada afirmación técnica lleva **`archivo:línea`** o **URL**.
- Cada tarea del plan lleva **estimación de esfuerzo y un criterio de aceptación verificable**.
- Distingue siempre entre **"esto está mal"**, **"esto es frágil"** y **"esto es una decisión
  de diseño que se puede mejorar"**.
- Si no estás seguro, dilo y explica qué habría que verificar.

**10.3 Sé honesto sobre el coste**

Sé explícito sobre el **coste real de arreglarlo ahora**: romperá la extensión actual,
requerirá migración de los usuarios que ya la tienen instalada (que instalaron un `.exe`
nativo con una clave ya registrada), y puede requerir renumerar de versión. Un plan que
ignore esto no es un plan.

**10.4 Idioma**

**Español.** Términos técnicos en inglés cuando sean los estándar (`service worker`,
`blob:`, `Range request`, `moov atom`). Comentarios y nombres de código propuestos en inglés.

**10.5 Contexto adicional que puedes asumir**

- El Mantenimiento es de una persona, no de un equipo.
- El host nativo ya está instalado en las máquinas de los usuariosque ya la instalaron (por eso hay que
  tener cuidado con los cambios de protocolo).
- La publicación en Chrome Web Store y AMO es el objetivo.
- `operant-web` (marketing) es un repo aparte y no está en alcance, salvo para coherencia.

---

## 11. Preguntas que DEBES responder explícitamente

1. ¿Cuál es **una sola decisión** que, si se tomara mañana, eliminaría más bugs que cualquier
   otra? Defiéndela.
2. El **content script debería seguir siendo el que decide el tipo de medio**? ¿O el
   detection debería pasar a ser un modelo **"descubrir URL candidatas crudo" → "verificar en
   el SW"** con caché de Content-Type/magic-bytes? Diseña ese contrato.
3. ¿Cómo se **resuelve el problema de `blob:`** en 2026 sin romper con MSE, WebCodecs,
   `ManagedMediaSource` y Service Workers? Diseña la estrategia y di qué es **imposible**.
4. Diseña el **modelo transaccional de la descarga**: cómo se garantiza que el fichero en
   disco es el prometido, completo y con el nombre correcto. Cubre: parciales, reanudado,
   chunks, Integrity, nombre final, temporales, limpieza, y qué se hace cuando Chrome
   interviene por encima (`uniquify`).
5. ¿Cuál es la **estrategia correcta de cookies/auth** bajo MV3? Evalúa: `cookies` permission
   vs `optional_permissions` on-demand vs captura real en la página (con `chrome.scripting`
   y un content script en un **iframe oculto** en la misma pestaña, que **sí** lleva la
   sesión del navegador) vs `declarativeNetRequest` con `modifyHeaders`. Considera el
   modelo de consentimiento y el riesgo de seguridad. **Esta es probablemente la decisión
   más importante del informe.**
6. ¿Cómo se hace la descarga **robusta a la terminación del MV3 service worker**? Compara
   `chrome.alarms` con **minutos de resolución**, documento offscreen, `Port` de keepalive,
   y **externalización del estado a `storage.session`**. Da el patrón concreto.
7. ¿Cómo se **evita la corrupción silenciosa** en HLS? Diseña el conjunto de invariantes que
   deben comprobarse antes de entregar un fichero, y **qué se hace** cuando no se pueden
   cumplir (¿fallar? ¿entregar parcial marcado?).
8. ¿Cómo se **gestiona el ciclo de vida de la cola** con persistencia y descarga de
   archivos de 100 GB, en una UI que puede cerrarse? Diseño del modelo de estado.
9. ¿Cómo se **arregla el puente del recorder** de forma que la página no pueda inyectar
   bytes? Evalúa: los 3 worlds, tokens en `sessionStorage` no accesible desde la página,
   validación de la forma del mensaje, y **cuál es el modelo de amenaza real** (¿es un
   problema? ¿la página ya puede hacer cosas peores?).
10. ¿Debe el host nativo **saber descargar por sí mismo**, con sus propias cookies
    (leyendo del perfil del navegador), o seguir delegando en el navegador? Decide y
    justifica.
11. ¿Cómo se **arregla la clave privada commiteada** sin romper a los usuarios que ya
    instalaron? Describe el procedimiento completo (rotación, purga, estrategia de ID).
12. ¿Cuál es el **primer commit** que hay que hacer mañana? Uno solo, quemás dé valor y que
    no rompa nada.

---

## 12. Formato de la respuesta

Empieza por un **resumen ejecutivo de 300 palabras**. Luego los cinco documentos de §9,
completos. Cierra con:

- **"Si solo pudieras hacer 3 cosas"** — las tres de mayor relación valor/esfuerzo.
- **"Lo que deliberadamente NO vamos a hacer"** — con razones.
- **"Los 5 riesgos que no controlamos"** — lo que depende de terceros (Chromium, YouTube,
  yt-dlp, los sitios, AMO/CWS) y qué haríamos si cada uno rompe.

Longitud objetivo: **denso, no largo**. Prefiere una tabla de 20 filas a 5 párrafos. Si algo
no cabe, es porque no es prioritario.
