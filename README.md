# Operant — Browser Agent & Media Engine

<p align="center">
  <strong>Motor de medios y agente de navegación para descubrimiento, extracción profunda y procesado de medios en la web moderna.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-brightgreen.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Companion-Rust%20Standalone-orange.svg" alt="Rust Native Host" />
  <img src="https://img.shields.io/badge/Engines-yt--dlp%20%7C%20ffmpeg-blue.svg" alt="Engines" />
  <img src="https://img.shields.io/badge/Tests-10%2F10%20PASS-success.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-lightgrey.svg" alt="License" />
</p>

---

## Descripción General

**Operant** es una extensión avanzada y modular para navegadores basados en Chromium (Chrome, Edge, Brave, Opera) y Firefox, diseñada para **descubrir, extraer, descargar y procesar medios desde cualquier página web**: imágenes en alta resolución, vídeos HTML5 nativos, audio, streams de red (HLS/DASH), enlaces de descarga y contenido protegido por visores dinámicos.

Incorpora un **Side Panel profesional** de alta densidad visual, descargas optimizadas con **Range requests en paralelo (chunks)**, un **host nativo autónomo en Rust puro (`operant-host.exe`)** que gestiona y ejecuta `ffmpeg` y `yt-dlp` fuera del sandbox del navegador, y un motor de grabación de buffers MSE para capturar flujos multimedia en tiempo real.

---

## Capacidades Principales

### 1. Detección Universal Profunda de Medios
* **Escaneo Exhaustivo en 5 Fases**: Inspecciona elementos `<img>`, `<picture>`, `srcset`, imágenes embebidas en `<svg>`, renders en `<canvas>` (editores gráficos y diagramas), y fondos CSS computados (`background-image`).
* **Resolución Original en Parámetros de Enlace**: Extrae las URLs reales de alta resolución contenidas en parámetros de enlaces (`imgurl`, `original`, `src`, `media`, `download`) en motores de búsqueda, galerías y agregadores web.
* **Atributos Dinámicos y Visores JS**: Decodifica atributos profundos (`data-src`, `data-zoom`, `data-original`, `data-highres`, `[m]`) y analiza estructuras de datos estructurados **Schema.org / JSON-LD**.
* **Captura de Red Pasiva (`webRequest`)**: Detecta automáticamente listas de reproducción y manifiestos de streaming (`.m3u8`, `.mpd`) mientras navegas, sin requerir interacción manual.

### 2. Barra de Progreso Milimétrica, Fluida y Transparente
* **Cálculo Unificado de Unidades de Trabajo**: La carga total se determina matemáticamente antes de comenzar ($N_{\text{img}} + N_{\text{links}} + N_{\text{deep}} + N_{\text{media}} + N_{\text{bg}}$), garantizando un avance monótono y exacto de 0% a 100%.
* **Contador en Vivo**: Notifica en tiempo real el número de medios descubiertos en cada fase (`found: store.size`) directamente en la barra.
* **Física y Estética Visual**: Gradiente *Signal Red* (`#e04e39` $\to$ `#f08271`), curva de aceleración cubic-bezier y tipografía con **números tabulares (`tabular-nums`)** para erradicar cualquier temblor o desplazamiento horizontal durante el conteo.

### 3. Ordenación Inteligente por Defecto (`sort: "smart"`)
* **Imágenes Grandes/Pesadas Primero en Orden Cronológico**: Sitúa el contenido principal de alta resolución en la parte superior respetando escrupulosamente su **orden natural de aparición en la página web** (de arriba hacia abajo en el DOM).
* **Relegación de Elementos Decorativos**: Favicons, avatares e iconos (< 100×100 px o < 3 KB) se envían al final de la cuadrícula sin entorpecer la visualización del contenido principal.

### 4. Desacoplamiento Estricto Imagen/Vídeo & Anti-Hotlinking
* **Aislamiento Total de Descargas**: Las imágenes y archivos se descargan directamente vía `chrome.downloads` o cola por chunks; nunca invocan `yt-dlp` ni modales de calidad de streaming.
* **Cabecera `referrerpolicy="no-referrer"`**: Aplicada universalmente a todas las tarjetas y al Lightbox, eliminando el origen de extensión (`chrome-extension://...`) para eludir bloqueos por anti-hotlink y CORS en servidores de terceros.
* **Miniatura Local como Respaldo Seguro**: Cada imagen de alta resolución conserva su miniatura funcional en el DOM (`item.thumb`). Si un servidor externo deniega el acceso o la URL remota expira, el panel y el Lightbox conmutan automáticamente a la miniatura local sin mostrar carteles de error ni dejar tarjetas rotas.

### 5. Operant Companion — Host Nativo Autónomo en Rust Puro
* **Binario Standalone Ligero (2.5 MB)**: Implementado en Rust (`native-host-rs/`), compilado en `native-host/operant-host.exe`. **Cero dependencias de Python, sin necesidad de consola.**
* **Registro en 1 Doble Clic**: Ejecutar `operant-host.exe` abre un asistente nativo con interfaz Win32 que detecta automáticamente los navegadores instalados (Chrome, Edge, Firefox) y registra el manifiesto de Native Messaging en el Registro de Windows.
* **Auto-Gestión de `yt-dlp` y `ffmpeg`**: Detecta versiones instaladas en el sistema (PATH) o en su directorio aislado (`~/Operant/bin/`). Descarga, verifica y actualiza binarios oficiales de forma atómica y silenciosa.
* **Procesado Multimedia de Alto Rendimiento**: Remux a MP4 sin pérdida, compresión H.264/AAC con CRF configurable, extracción de audio MP3 y reescalado de vídeo.

### 6. Grabación de Buffers MSE en Tiempo Real
* Captura los segmentos multimedia transmitidos por reproductores web modernos directamente desde el contexto de la página.
* Transfiere los flujos al host nativo para su concatenación y empaquetado instantáneo con `ffmpeg` en `~/Downloads/Operant/`.

---

## Estructura del Repositorio

```
operant/
├── src/                               # Extensión de navegador (Manifest V3)
│   ├── manifest.json                  # Declaración MV3, sidePanel, permissions
│   ├── background.js                  # Service worker: captura webRequest, DNR, Native Messaging
│   ├── content.js                     # Motor de escaneo profundo (DOM, links, deep attrs, CSS)
│   ├── recorder-main.js               # Inyector de captura de buffers MSE en páginas web
│   ├── panel/
│   │   ├── panel.html                 # Interfaz consolidada del panel lateral
│   │   ├── panel.js                   # Lógica de UI, filtros, lightbox, descargas y estado
│   │   └── panel.css                  # Sistema de diseño Operant (Warm Ink + Signal Red)
│   ├── shared/
│   │   ├── media-core.js              # Clasificador universal de medios y detección mágica
│   │   ├── hls-fast.js                # Parser y descargador HLS en navegador (fMP4/TS)
│   │   └── dl-indicator.js            # Anillo de progreso y micro-interacciones de descarga
│   ├── vendor/
│   │   └── jszip.min.js               # Empaquetador ZIP local sin dependencias de red
│   └── icons/                         # Identidad visual de la extensión (16, 48, 128 px)
│
├── native-host/                       # Aplicación satélite Native Messaging
│   ├── operant-host.exe               # Binario autónomo compilado en Rust (Windows)
│   ├── operant_host.py                # Host de referencia en Python (stdlib pura)
│   ├── install_host.bat / .sh         # Scripts de registro multiplataforma
│   └── operant_host_manifest.json     # Plantilla de manifiesto Native Messaging
│
├── native-host-rs/                    # Código fuente en Rust del Operant Companion
│   ├── Cargo.toml                     # Configuración del paquete Cargo y dependencias
│   └── src/                           # main.rs, installer.rs, protocol.rs, tools.rs, ytdl.rs, recorder.rs
│
└── tests/                             # Batería exhaustiva de pruebas funcionales
    ├── run-verification.js            # Runner automatizado con Chrome for Testing (10/10 PASS)
    ├── host-e2e.py                    # Suite de validación del host nativo (11/11 PASS)
    ├── fixtures-server.js             # Servidor local de casos de prueba deterministas
    └── TESTING.md                     # Documentación completa de resultados y auditoría
```

---

## Instalación y Puesta en Marcha

### 1. Cargar la Extensión en el Navegador
1. Clona el repositorio:
   ```bash
   git clone https://github.com/planobinario/operant.git
   cd operant
   ```
2. Instala dependencias de desarrollo y compila los paquetes:
   ```bash
   npm install
   npm run build
   ```
3. En Google Chrome o Microsoft Edge, navega a `chrome://extensions/`.
4. Activa el **Modo de desarrollador** (esquina superior derecha).
5. Pulsa **Cargar descomprimida** y selecciona la carpeta **`src/`** del repositorio.

### 2. Activar el Operant Companion (Host Nativo)
* **En Windows (Recomendado)**:
  1. Ve a la carpeta `native-host/` y haz **doble clic en `operant-host.exe`**.
  2. Un cuadro de diálogo confirmará la vinculación con Chrome, Edge y Firefox automáticamente.
* **En Linux / macOS (o usando Python)**:
  ```bash
  cd native-host
  chmod +x install_host.sh
  ./install_host.sh <ID_DE_TU_EXTENSION>
  ```
  *(Puedes consultar el ID de tu extensión en `chrome://extensions`).*

---

## Scripts Disponibles

| Comando | Acción |
|---|---|
| `npm run dev` | Lanza una instancia aislada de Chromium con la extensión cargada y recarga automática. |
| `npm run dev:firefox` | Compila el manifiesto compatible y lanza Firefox con la extensión. |
| `npm run build` | Empaqueta la extensión para producción en `web-ext-artifacts/operant_*.zip`. |
| `npm run test:verify` | Ejecuta la batería de pruebas locales deterministas (10 suites en Chrome for Testing). |
| `npm run test:verify:public` | Ejecuta las pruebas locales más 5 validaciones sobre sitios web públicos reales. |
| `npm run host:build` | Compila el host nativo en Rust con optimizaciones de release y copia el ejecutable a `native-host/`. |
| `npm run host:test` | Ejecuta la suite de verificación de protocolo, herramientas y ffmpeg del host nativo. |

---

## Sistema de Diseño y Estética

Operant utiliza los tokens de diseño oficiales de **Warm Ink Neutrals**:

* **Tema Oscuro**:
  * Fondo: `#161311` (`--bg`) | Superficies: `#1d1a17` (`--surface`), `#232019` (`--surface-2`)
  * Bordes: `#322d27` (`--border`) | Bordes acentuados: `#474038` (`--border-strong`)
  * Color de Acento: `#f2554d` (*Signal Red*)
  * Texto: `#ece8e2` (`--text`) | Texto atenuado: `#a49c92` (`--text-muted`)
* **Tema Claro**:
  * Fondo: `#f7f5f2` | Superficies: `#fdfcfa`, `#efece7`
  * Bordes: `#e4e0d9` | Acento: `#cc2929`
* **Tipografía de Precisión**: Inter para interfaces de usuario y JetBrains Mono para insignias de dimensiones (`1920×1080`), formatos (`WEBP`, `MP4`) y tamaños de archivo.
* **Selector de Tema Cero-Latencia**: Alternancia instantánea entre Claro y Oscuro con persistencia en `chrome.storage.local`.

---

## Permisos del Navegador

| Permiso | Justificación Técnica |
|---|---|
| `sidePanel` | Panel lateral persistente que no interrumpe la navegación del usuario. |
| `webRequest` | Detección pasiva de flujos multimedia de red (`m3u8`, `mpd`) que no existen en el DOM. |
| `downloads` | Gestión y guardado de descargas individuales y archivos ZIP consolidados. |
| `storage` | Persistencia de preferencias del usuario y estado de medios por pestaña (`storage.session`). |
| `activeTab` | Enlace seguro a la pestaña activa para solicitar re-escaneos. |
| `nativeMessaging` | Canal de comunicación bidireccional con el Operant Companion (`operant-host.exe`). |
| `declarativeNetRequest` | Reglas efímeras de cabeceras para descargas protegidas por anti-hotlinking. |
| `host_permissions: <all_urls>` | Inyección del content script y análisis universal sin listas blancas restrictivas. |

---

## Licencia

Distribuido bajo licencia **GPL-3.0-or-later**. Consulta el archivo `LICENSE` para más detalles.
