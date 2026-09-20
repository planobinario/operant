// content.js — Escáner exhaustivo de medios de Operant.
// Vive dentro de la página (matches: <all_urls>) y encuentra:
//   imágenes, vídeos, audio y archivos descargables (DOM + lazy-load + CSS + embeds).
// Además recibe del service worker los medios capturados por webRequest (streams).

const MAX_ITEMS = 4000;

// --- Clasificación por extensión de URL ---
const EXT_GROUPS = {
  image: /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|heic|jxl)(?:[?#].*)?$/i,
  video: /\.(mp4|webm|mkv|avi|mov|m4v|ts|m3u8|mpd|ogv|3gp|flv|wmv)(?:[?#].*)?$/i,
  audio: /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|wma|aiff?)(?:[?#].*)?$/i,
  file: /\.(pdf|zip|rar|7z|tar|gz|bz2|xz|docx?|xlsx?|pptx?|epub|apk|exe|msi|dmg|iso|txt|md|json|csv)(?:[?#].*)?$/i,
};

function classify(url) {
  for (const [kind, re] of Object.entries(EXT_GROUPS)) {
    if (re.test(url)) return kind;
  }
  return null;
}

function extOf(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]+)(?:$|[?#])/i);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Normaliza a URL absoluta; descarta data: (embebido en base64, ruido).
function normalize(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) return null;
  try {
    return new URL(url, location.href).href;
  } catch {
    return null;
  }
}

function parseSrcset(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// Atributos típicos de lazy-loading en imágenes.
const LAZY_ATTRS = [
  "src",
  "srcset",
  "data-src",
  "data-lazy-src",
  "data-lazy",
  "data-original",
  "data-url",
  "data-image",
  "data-actualsrc",
  "data-srcset",
];

// --- Almacén deduplicado: URL normalizada -> item ---
const store = new Map();
let notifying = false;

function notify() {
  if (notifying) return;
  notifying = true;
  setTimeout(() => {
    notifying = false;
    // Re-consultar la Performance API para items sin tamaño (lazy-load tardío):
    // el navegador ya pudo cargar el recurso después del escaneo inicial.
    for (const item of store.values()) {
      if (item.sizeBytes === null) item.sizeBytes = perfSizeBytes(item.url);
    }
    chrome.runtime.sendMessage({ type: "media-updated", items: [...store.values()] }).catch(() => {});
  }, 350);
}

function add(url, kind, extra = {}) {
  const normalized = normalize(url);
  if (!normalized) return;
  const key = normalized.split("#")[0];
  const existing = store.get(key);
  if (existing) {
    if (extra.thumb && !existing.thumb) existing.thumb = extra.thumb;
    if (extra.durationSec && !existing.durationSec) existing.durationSec = extra.durationSec;
    if (existing.sizeUnknown === undefined && extra.sizeUnknown) existing.sizeUnknown = true;
    return;
  }
  if (store.size >= MAX_ITEMS) return;
  const item = {
    url: normalized,
    type: kind,
    ext: extOf(normalized),
    domain: domainOf(normalized),
    sizeKB: null,
    sizeUnknown: false,
    sizeBytes: perfSizeBytes(normalized), // Técnica 1: Performance Resource Timing
    source: "dom",
    // Método de detección (para el badge de la UI y la jerarquía de descarga):
    //   dom      -> <video>/<source>/<img> con URL directa en el DOM
    //   manifest -> .m3u8/.mpd (HLS/DASH): se puede parsear sin yt-dlp
    //   embed    -> embed de plataforma (YouTube/Vimeo…): solo yt-dlp
    method: extra.method || defaultMethod(normalized, kind, extra),
    ...extra,
  };
  store.set(key, item);
  notify();
}

// Técnica 1 (la más elegante): el navegador ya registró el tamaño real del
// recurso al cargarlo para la página. performance.getEntriesByType('resource')
// expone encodedBodySize (bytes transferidos) sin gastar ninguna petición.
// Devuelve bytes, o null si el recurso no está en el buffer / es 0.
function perfSizeBytes(url) {
  try {
    const entries = performance.getEntriesByType("resource");
    // La URL puede tener fragmento; comparar normalizando.
    const want = url.split("#")[0];
    for (const e of entries) {
      if (e.name === url || e.name.split("#")[0] === want) {
        const s = Number(e.encodedBodySize || 0);
        return s > 0 ? s : null;
      }
    }
  } catch {
    /* Performance API no disponible */
  }
  return null;
}

// Captura un frame real del <video> de la página (canvas) como thumbnail.
// Se ejecuta en el content script (con la sesión/Referer de la página), así
// que no le afecta el CORS que bloquea la captura desde el panel. Devuelve
// un dataURL JPEG, o null si no se pudo.
function captureVideoThumb(src, videoEl) {
  return new Promise((resolve) => {
    try {
      const v = videoEl || document.createElement("video");
      const w = v.videoWidth || 640;
      const h = v.videoHeight || 360;
      if (!w || !h) return resolve(null);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      // Si el vídeo del DOM no está en readyState >= 2, cargar uno nuevo
      // (muted + preload metadata) para capturar el primer frame.
      const tryDraw = () => {
        try {
          ctx.drawImage(v, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.7));
        } catch {
          resolve(null);
        }
      };
      if (v.readyState >= 2 && v.videoWidth > 0) {
        tryDraw();
      } else {
        const nv = document.createElement("video");
        nv.muted = true;
        nv.playsInline = true;
        nv.preload = "metadata";
        nv.crossOrigin = "anonymous";
        nv.src = src;
        const timer = setTimeout(() => resolve(null), 8000);
        nv.addEventListener("loadeddata", () => {
          try {
            clearTimeout(timer);
            ctx.drawImage(nv, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.7));
          } catch {
            clearTimeout(timer);
            resolve(null);
          }
        }, { once: true });
        nv.addEventListener("error", () => { clearTimeout(timer); resolve(null); }, { once: true });
      }
    } catch {
      resolve(null);
    }
  });
}

// Método por defecto según la URL y el contexto de detección.
function defaultMethod(url, kind, extra) {
  if (extra.embed) return "embed";
  if (kind === "video" && /\.(m3u8|mpd)(?:[?#].*)?$/i.test(url)) return "manifest";
  return "dom";
}

// --- Escaneos individuales ---

// Travesía con soporte de Shadow DOM: recoge todos los open shadow roots
// (incluidos los anidados) para que el escáner vea también el contenido
// de componentes web. Los shadow roots *cerrados* no son inspeccionables.
function allShadowRoots() {
  const roots = [];
  const seen = new Set();
  (function walk(root) {
    if (seen.has(root)) return;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    }
  })(document);
  return roots;
}

// Documentos de iframes SAME-ORIGIN: se puede acceder a su contentDocument.
// Los cross-origin no son inspeccionables (limitación del navegador); sus
// peticiones se capturan por separado vía webRequest en background.js.
function allIframeDocs() {
  const docs = [];
  const seen = new Set();
  (function walk(doc) {
    if (seen.has(doc)) return;
    seen.add(doc);
    for (const frame of doc.querySelectorAll("iframe")) {
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        inner = null; // cross-origin: inaccesible, se cubre con webRequest
      }
      if (inner && inner !== doc) {
        docs.push(inner);
        walk(inner);
      }
    }
  })(document);
  return docs;
}

function allRoots() {
  return [document, ...allShadowRoots(), ...allIframeDocs()];
}

function qsaAll(selector) {
  const out = [];
  for (const root of allRoots()) {
    out.push(...root.querySelectorAll(selector));
  }
  return out;
}

function scanImages() {
  for (const img of qsaAll("img")) {
    const extra = {
      w: img.naturalWidth || null,
      h: img.naturalHeight || null,
    };
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      if (attr === "srcset" || attr === "data-srcset") {
        for (const c of parseSrcset(value)) add(c, "image", extra);
      } else {
        add(value, "image", extra);
      }
    }
  }

  // <picture><source srcset>
  for (const source of qsaAll("picture source")) {
    for (const c of parseSrcset(source.getAttribute("srcset"))) add(c, "image");
    const s = source.getAttribute("src");
    if (s) add(s, "image");
  }

  // <noscript> con <img> dentro (fallback de lazy-load): el navegador no
  // activa su contenido, hay que parsear el HTML crudo como texto.
  for (const ns of qsaAll("noscript")) {
    const raw = ns.textContent || ns.innerHTML || "";
    const srcsetAll = raw.match(/srcset\s*=\s*["'][^"']*["']/gi) || [];
    for (const s of srcsetAll) {
      const inner = s.replace(/^srcset\s*=\s*["']|["']$/gi, "");
      for (const c of parseSrcset(inner)) add(c, "image");
    }
    const srcs = raw.match(/\bsrc\s*=\s*["'][^"']*["']/gi) || [];
    for (const s of srcs) {
      const url = s.replace(/^\s*src\s*=\s*["']|["']$/gi, "").trim();
      if (url && !url.startsWith("data:")) add(url, "image");
    }
  }
}

const URL_RE = /url\((["']?)(.*?)\1\)/g;

// --- Progreso real de escaneo (feedback no decorativo en el panel) ---
// La fase lenta es el barrido de background-image por tandas; se reporta
// done/total de elementos procesados, throttled a 120 ms.
let scanTotal = 0;
let scanDone = 0;
let lastProgressAt = 0;

function reportProgress() {
  const now = Date.now();
  if (now - lastProgressAt < 120) return;
  lastProgressAt = now;
  chrome.runtime
    .sendMessage({ type: "scan-progress", done: scanDone, total: scanTotal, phase: "estilos" })
    .catch(() => {});
}

function scanBackgroundImages() {
  // background-image en CSS computado, en tandas de 400 elementos vía idle.
  const all = qsaAll("*");
  scanTotal = all.length;
  scanDone = 0;
  reportProgress();
  let i = 0;
  function step() {
    const end = Math.min(i + 400, all.length);
    for (; i < end; i++) {
      const bg = getComputedStyle(all[i]).backgroundImage;
      if (!bg || bg === "none") continue;
      let m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(bg))) {
        if (m[2] && !m[2].startsWith("data:")) add(m[2], "image");
      }
    }
    scanDone = end;
    reportProgress();
    if (i < all.length) {
      if ("requestIdleCallback" in window) requestIdleCallback(step, { timeout: 80 });
      else setTimeout(step, 80);
    }
  }
  step();
}

const EMBED_PATTERNS = [
  // YouTube: watch?v=ID, youtu.be/ID, /embed/ID, /shorts/ID
  {
    platform: "youtube",
    test: /youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/shorts\//i,
    id: (src) => {
      const m = src.match(/(?:v=|embed\/|youtu\.be\/|shorts\/)([\w-]{6,})/);
      return m ? m[1] : null;
    },
    thumb: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  },
  {
    platform: "vimeo",
    test: /vimeo\.com\/(video\/|embed\/)?\d+/i,
    id: (src) => {
      const m = src.match(/(\d{6,})/);
      return m ? m[1] : null;
    },
  },
  {
    platform: "dailymotion",
    test: /dailymotion\.com\/(video|embed\/video)\//i,
    id: (src) => {
      const m = src.match(/(?:video|embed\/video)\/([\w]+)/);
      return m ? m[1] : null;
    },
    thumb: (id) => `https://www.dailymotion.com/thumbnail/video/${id}`,
  },
  {
    platform: "twitter",
    test: /(twitter\.com|x\.com)\/(i\/videos|.*\/status\/)/i,
  },
];

function embedInfo(src) {
  for (const p of EMBED_PATTERNS) {
    if (p.test.test(src)) {
      const id = p.id ? p.id(src) : null;
      return {
        platform: p.platform,
        id,
        thumb: id && p.thumb ? p.thumb(id) : null,
      };
    }
  }
  return null;
}

function scanVideosAndAudio() {
  for (const v of qsaAll("video")) {
    const src = v.currentSrc || v.getAttribute("src");
    const extra = {
      durationSec: v.duration && isFinite(v.duration) ? v.duration : null,
      w: v.videoWidth || null,
      h: v.videoHeight || null,
      // Poster real del <video> como thumbnail del item (Bug 1: preview).
      thumb: v.poster && v.poster.startsWith("http") ? v.poster : null,
    };
    if (src) add(src, "video", extra);
    if (v.poster) add(v.poster, "image");
    // Fallback: si el vídeo no tiene poster, capturar un frame real con canvas
    // (el content script está en la página con sesión/Referer — evita el CORS
    // que bloquea la captura desde el panel). Se hace en segundo plano y solo
    // si el vídeo está cargado.
    if (!extra.thumb && src && v.readyState >= 2) {
      captureVideoThumb(src, v).then((dataUrl) => {
        if (!dataUrl) return;
        const existing = store.get(src.split("#")[0]);
        if (existing && !existing.thumb) {
          existing.thumb = dataUrl;
          notify();
        }
      }).catch(() => {});
    }
    for (const s of v.querySelectorAll("source")) {
      if (s.src) add(s.src, "video", extra);
    }
  }
  for (const a of qsaAll("audio")) {
    const src = a.currentSrc || a.getAttribute("src");
    if (src) add(src, "audio");
    for (const s of a.querySelectorAll("source")) {
      if (s.src) add(s.src, "audio");
    }
  }
  for (const el of qsaAll("object, embed")) {
    const d = el.getAttribute("data") || el.src;
    if (d) add(d, classify(d) || "video");
  }
  for (const frame of qsaAll("iframe")) {
    const src = frame.src || "";
    const embed = embedInfo(src);
    if (embed) {
      add(src, "video", { embed: embed.platform, embedId: embed.id, thumb: embed.thumb });
    }
  }
}

function scanDownloadLinks() {
  for (const a of qsaAll("a[href]")) {
    const href = a.href;
    if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
    if (href.startsWith(location.origin) && href === location.href.split("#")[0]) continue;
    const kind = classify(href);
    if (kind === "file" || kind === "video" || kind === "audio") {
      add(href, kind === "file" ? "file" : kind);
    }
  }
}

// --- Escaneo completo + observer de mutaciones ---

const OBSERVER_OPTS = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "data-src", "data-lazy-src", "data-original", "href"],
};

// Detectar contenido cargado dinámicamente (infinite scroll, SPAs).
const observer = new MutationObserver(() => scheduleRescan());
const observedRoots = new Set();

function ensureObserved() {
  for (const root of [...allShadowRoots(), ...allIframeDocs()]) {
    if (observedRoots.has(root)) continue;
    observedRoots.add(root);
    observer.observe(root, OBSERVER_OPTS);
  }
}

function fullScan() {
  scanImages();
  scanDownloadLinks();
  scanVideosAndAudio();
  scanBackgroundImages();
  ensureObserved(); // vigilar también los shadow roots descubiertos
  notify();
}

let rescanTimer = null;

function scheduleRescan() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(fullScan, 800);
}

// --- Re-escaneo tras interacción (clicks en botones tipo "cargar más") ---
// Patrones comunes de texto en botones de carga paginada/infinite.
const LOAD_MORE_RE = /(cargar m[áa]s|ver m[áa]s|load more|show more|mostrar m[áa]s|siguiente p[áa]gina|next page|m[áa]s resultados|ver todas|see all|load all|expandir|expand)/i;

let clickDebounce = null;

function handleUserClick(ev) {
  const target = ev.target instanceof Element ? ev.target.closest("button, a[role='button'], [onclick]") : null;
  if (!target) return;
  const text = (target.textContent || target.getAttribute("aria-label") || "").trim();
  if (!text) return;
  // Re-escanea si el click sugiere carga de más contenido.
  if (LOAD_MORE_RE.test(text)) {
    clearTimeout(clickDebounce);
    clickDebounce = setTimeout(() => {
      fullScan();
      ensureObserved();
    }, 1200); // esperar a que el contenido nuevo se pinte
  }
}

// Captura de clicks a nivel de documento (capture: también dentro de shadow
// roots / iframes same-origin). No interfiere con el comportamiento normal.
document.addEventListener("click", handleUserClick, { capture: true, passive: true });

// --- Auto-scroll activo (estilo ImageEye) ---
// Recorre la página hacia abajo en saltos de viewport, espera a que el
// lazy-load dispare, re-escanea y repite hasta el final del scrollHeight.
// Con cancelación y devolución del scroll a su posición original.

let activeScan = null; // { cancelled: boolean, originalScrollY }

const SCROLL_STEP_WAIT = 400; // ms de espera tras cada salto (lazy-load)

function scanProgressMsg(done, total, phase) {
  chrome.runtime.sendMessage({ type: "scan-progress", done, total, phase }).catch(() => {});
}

async function autoScrollScan() {
  if (activeScan) return; // ya hay un escaneo en curso
  activeScan = { cancelled: false, originalScrollY: window.scrollY };
  const originalScrollY = activeScan.originalScrollY;

  try {
    // Primera pasada completa del DOM tal cual (incluye lo ya visible).
    fullScan();

    // Ciclo de scroll: baja de viewport en viewport, re-escanea en cada parada.
    const viewport = Math.max(window.innerHeight || 800, 200);
    let y = 0;
    let stable = 0; // cuántas paradas seguidas sin crecer el scrollHeight
    let step = 0;

    while (!activeScan.cancelled) {
      const before = document.documentElement.scrollHeight;
      y += viewport;
      window.scrollTo(0, y);
      scanProgressMsg(step, 0, `scroll ${step + 1}`);
      await wait(SCROLL_STEP_WAIT);
      fullScan();

      const after = document.documentElement.scrollHeight;
      if (after <= before) {
        stable++;
      } else {
        stable = 0;
      }
      step++;

      // Fin de página: no se puede bajar más.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) break;
      // Scroll infinito estancado: 3 paradas sin crecer = hemos llegado al final real.
      if (stable >= 3) break;
      // Cota de seguridad: nunca más de 200 pasos.
      if (step >= 200) break;
    }
  } finally {
    // Devolver el scroll del usuario a su posición original.
    window.scrollTo(0, originalScrollY);
    activeScan = null;
    scanProgressMsg(0, 0, "done");
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cancelActiveScan() {
  if (activeScan) activeScan.cancelled = true;
}

// --- Mensajería con el service worker y el panel ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "scan") {
    sendResponse({ items: [...store.values()] });
    return;
  }
  if (msg?.type === "force-rescan") {
    autoScrollScan();
    sendResponse({ items: [...store.values()] });
    return;
  }
  if (msg?.type === "reset-state") {
    // Navegación SPA (pushState sin recarga): el documento sigue vivo pero
    // el contenido es de otra página. Se limpia el store local para no
    // arrastrar items de la vista anterior y se re-escanea la nueva.
    store.clear();
    console.log("[operant-content] reset-state (SPA) en", location.href);
    fullScan();
    ensureObserved();
    sendResponse({ ok: true, count: store.size });
    return;
  }
  if (msg?.type === "cancel-scan") {
    cancelActiveScan();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "ping") {
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "network-media") {
    for (const raw of msg.items || []) {
      add(raw.url, raw.type, { source: "network", thumb: raw.thumb, method: raw.method });
    }
    sendResponse({ ok: true, count: store.size });
  }
  if (msg?.type === "capture-in-page") {
    // Fallback anti-hotlink del panel: capturar el recurso DESDE esta página
    // (con cookies + Referer de sesión) y reenviar el blob al SW/panel.
    overlayDownloadInPage(msg.url || "", msg.filename || "").then(
      (r) => sendResponse(r),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true; // respuesta asíncrona
  }
});

// Escaneo inicial (document_idle: DOM ya disponible).
console.log("[operant-content] fullScan inicial en", location.href);
// Ampliar el buffer de Resource Timing: con cientos de imágenes las entradas
// por defecto (250) se pierden y la Técnica 1 no encuentra el tamaño.
if (performance.setResourceTimingBufferSize) {
  try {
    performance.setResourceTimingBufferSize(2000);
  } catch {
    /* algunos entornos no permiten ampliarlo */
  }
}
fullScan();
console.log("[operant-content] tras fullScan inicial:", store.size, "items en", location.href);

// Handshake: el SW puede haber capturado streams (m3u8/mpd/ts) antes de que
// este content script se inyectara; se los pedimos para no perderlos.
setTimeout(() => {
  chrome.runtime.sendMessage({ type: "content-ready" }).catch(() => {});
}, 150);

// ============================================================================
// OVERLAY EN LA PÁGINA REAL (estilo Double-click Image Downloader)
// Capa INDEPENDIENTE del side panel: un botón flotante sobre cada imagen/vídeo
// del DOM mientras el usuario navega, sin abrir el panel. Con toggle global y
// blacklist por dominio (persistidos en storage.local).
// ============================================================================

let overlayEnabled = true;
let overlayDomainBlacklist = [];
// Filtros del overlay (configurables desde el panel > Opciones):
// - overlayMinSize: tamaño mínimo (px) del lado menor del elemento para
//   mostrar el overlay. 0 = sin mínimo (mostrar todo).
// - overlayIgnoreSvg: si true, no mostrar el overlay sobre imágenes SVG
//   (suelen ser iconos/logos sin valor de descarga).
let overlayMinSize = 0;
let overlayIgnoreSvg = true;

function overlayAllowedFor(loc) {
  if (!overlayEnabled) return false;
  const host = (loc.hostname || "").replace(/^www\./, "");
  return !overlayDomainBlacklist.includes(host);
}

function loadOverlayPrefs() {
  try {
    chrome.storage.local.get(["overlayEnabled", "overlayBlacklist", "overlayMinSize", "overlayIgnoreSvg"], (data) => {
      overlayEnabled = data.overlayEnabled !== false;
      overlayDomainBlacklist = Array.isArray(data.overlayBlacklist) ? data.overlayBlacklist : [];
      const min = Number(data.overlayMinSize);
      overlayMinSize = Number.isFinite(min) && min >= 0 ? min : 0;
      overlayIgnoreSvg = data.overlayIgnoreSvg !== false;
    });
  } catch {
    /* storage no disponible */
  }
}

// ¿El elemento es elegible para mostrar el overlay según los filtros
// configurables (tamaño mínimo y exclusión de SVG)?
function overlayTargetEligible(el) {
  if (overlayMinSize > 0) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && Math.min(r.width, r.height) < overlayMinSize) return false;
  }
  if (overlayIgnoreSvg) {
    // SVG directo (elemento <svg> o <img src="*.svg">): iconos/logos, se ignoran.
    if (el instanceof SVGSVGElement) return false;
    if (el instanceof HTMLImageElement) {
      const src = (el.currentSrc || el.src || "").toLowerCase();
      if (/\.svg($|[?#])/.test(src)) return false;
    }
  }
  return true;
}

// Elemento overlay único (reutilizado, no se crea por imagen).
let pageOverlay = null;
let pageOverlayTarget = null; // elemento bajo el que está anclado
let overlayHideTimer = null;
// Estado del anclaje actual (reactividad estricta): la URL que representan
// los iconos y el rect del target cuando se mostró. Si cualquiera cambia,
// el overlay se re-crea/re-posiciona inmediatamente.
let overlayShownUrl = "";
let overlayTargetRect = null;
// --- CSS Anchor Positioning (modo nativo) ---
// En navegadores con soporte (Chrome 125+), el overlay se posiciona con la
// API nativa: el motor de renderizado lo mueve con el ancla en el hilo de
// composición (sincronización perfecta durante scroll, sin JS en el camino).
// En navegadores sin soporte, se usa el fallback JS (getBoundingClientRect +
// scroll listener) dentro del MISMO estilo, bajo `@supports not`.
// Soporte detectado en runtime. Para testing/fallback forzado, el documento
// puede desactivarlo con <html data-nt-no-anchors> (lo lee el content script).
const supportsAnchorPositioning =
  typeof CSS !== "undefined" &&
  !!CSS.supports &&
  CSS.supports("anchor-name", "--nt-test") &&
  !(document.documentElement && document.documentElement.hasAttribute("data-nt-no-anchors"));
// Nombre de ancla del target actual (solo en modo nativo). Se asigna al
// elemento detectado bajo el cursor y lo referencia el overlay.
let overlayAnchorName = null;
let overlayAnchorSeq = 0; // para generar nombres únicos por elemento
const overlayAnchorCache = new WeakMap(); // elemento -> anchor-name (no re-asignar si sigue siendo el mismo)

function ensurePageOverlay() {
  if (pageOverlay) return pageOverlay;
  pageOverlay = document.createElement("div");
  pageOverlay.id = "nt-page-overlay";
  pageOverlay.setAttribute("data-nt", "1");
  // Modo nativo: atributo para que el CSS aplique el posicionamiento por ancla.
  if (supportsAnchorPositioning) pageOverlay.setAttribute("data-anchored", "1");
  // El propio overlay actúa como ancla del popover (el popover se abre debajo
  // de los iconos). Nombre fijo: el popover lo referencia como --nt-ov-anchor.
  try {
    pageOverlay.style.setProperty("anchor-name", "--nt-ov-anchor");
  } catch {
    /* navegador sin soporte */
  }
  pageOverlay.hidden = true;
  document.documentElement.appendChild(pageOverlay);
  return pageOverlay;
}

// Asigna (o recupera) un anchor-name único al elemento, y devuelve ese nombre.
// Solo en modo nativo: el CSS lo usa como `position-anchor`.
function overlayAnchorNameFor(el) {
  const cached = overlayAnchorCache.get(el);
  if (cached) return cached;
  const name = `--nt-anchor-${++overlayAnchorSeq}`;
  overlayAnchorCache.set(el, name);
  try {
    el.style.setProperty("anchor-name", name);
  } catch {
    /* navegador sin soporte: no pasa nada */
  }
  return name;
}

// URL de mayor resolución (quita parámetros de resize de CDN).
function overlayBestUrl(url) {
  try {
    const u = new URL(url);
    u.search = u.search.replace(/(?:[?&](?:w|width|h|height|resize|s|size|maxwidth|maxheight)=[^&]*)/gi, "");
    if (u.search !== new URL(url).search) return u.href;
  } catch {
    /* no parseable */
  }
  return url;
}

// Extensión de un URL (para clasificar enlaces/backgrounds).
function overlayExtOf(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]+)(?:$|[?#])/i);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

// Clasifica una URL como archivo descargable (mismas reglas que el escáner).
const OVERLAY_FILE_RE = /\.(pdf|zip|rar|7z|tar|gz|bz2|xz|docx?|xlsx?|pptx?|epub|apk|exe|msi|dmg|iso|txt|md|json|csv|mp4|webm|mkv|avi|mov|m4v|ts|m3u8|mpd|ogv|3gp|flv|wmv|mp3|m4a|aac|wav|ogg|oga|flac|opus|wma|aiff?)(?:[?#].*)?$/i;

// Busca el elemento "ancla" más cercano bajo el ratón, de forma EXHAUSTIVA:
// img, video, audio, source, object, embed, y cualquier elemento cuyo
// background-image contenga una URL real (divs con fotos de fondo).
function overlayFindTarget(el) {
  // Subir por el árbol hasta encontrar un elemento detectable directo.
  let node = el;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLImageElement) return node;
    if (node instanceof HTMLVideoElement) return node;
    if (node instanceof HTMLAudioElement) return node;
    if (node instanceof HTMLSourceElement && (node.src || node.getAttribute("srcset"))) return node;
    if (node instanceof HTMLObjectElement || node instanceof HTMLEmbedElement) {
      const d = node.getAttribute("data") || node.src;
      if (d) return node;
    }
    // Enlaces a archivos (no cualquier enlace: solo los descargables).
    if (node instanceof HTMLAnchorElement && node.href && OVERLAY_FILE_RE.test(node.href)) return node;
    node = node.parentElement;
  }
  // Última opción: un elemento con background-image real (foto de fondo CSS).
  try {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none" && /url\(/.test(bg)) return el;
  } catch {
    /* sin estilo computado */
  }
  return null;
}

// Extrae la URL usable de un elemento detectado (src actual / source / objeto /
// background-image / enlace).
function overlayUrlOf(el) {
  if (el instanceof HTMLImageElement) return el.currentSrc || el.src || "";
  if (el instanceof HTMLVideoElement) return el.currentSrc || el.src || "";
  if (el instanceof HTMLAudioElement) return el.currentSrc || el.src || "";
  if (el instanceof HTMLSourceElement) return el.currentSrc || el.src || "";
  if (el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement) return el.getAttribute("data") || el.src || "";
  if (el instanceof HTMLAnchorElement) return el.href || "";
  // background-image CSS: extraer la primera url(...).
  try {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(\s*["']?(.*?)["']?\s*\)/);
    if (m && m[1] && !m[1].startsWith("data:")) return m[1];
  } catch {
    /* sin estilo */
  }
  return "";
}

// Tipo (imagen/video/audio/archivo) de un elemento detectado.
function overlayTypeOf(el) {
  if (el instanceof HTMLVideoElement) return "video";
  if (el instanceof HTMLAudioElement) return "audio";
  if (el instanceof HTMLImageElement || el instanceof HTMLSourceElement) return "image";
  if (el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement) {
    const d = el.getAttribute("data") || el.src || "";
    return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(?:[?#].*)?$/i.test(d) ? "image" : "file";
  }
  if (el instanceof HTMLAnchorElement) return "file";
  // background-image = imagen.
  return "image";
}

// Iconos SVG inline (stroke actualColor, geometría milimétrica en viewBox 20×20,
// trazo 1.5 UNIFORME en todo el set, estilo outline consistente estilo Lucide).
function overlayIcon(name) {
  const paths = {
    // Descargar: flecha hacia abajo dentro de una bandeja.
    download:
      '<path d="M10 3.5v8.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6.6 8.4 10 11.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 13.2v1.6a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6v-1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    // Fotograma: cámara con círculo de lente centrado.
    frame:
      '<rect x="2.8" y="4.6" width="14.4" height="11.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.6 3h4.8M10 3v1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    // Imagen: marco con montaña y sol (composición clásica).
    image:
      '<rect x="2.6" y="4.4" width="14.8" height="11.2" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7.6" cy="8.6" r="1.3" fill="currentColor"/><path d="M3.4 14.2l4.2-4.2 3.2 3.2 2.4-2.4 3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    // Audio: altavoz Lucide (cuerpo con fill + onda con stroke) — correcto.
    audio:
      '<path d="M11 5.2 6.4 8.6H3.4a.6.6 0 0 0-.6.6v1.6a.6.6 0 0 0 .6.6h3L11 14.8V5.2z" fill="currentColor" stroke="none"/><path d="M13.4 7.2a4.6 4.6 0 0 1 0 5.6M15.8 5.2a7.6 7.6 0 0 1 0 9.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    // Solo audio: NOTA MUSICAL (corchea Lucide: plica + corchea + 2 círculos).
    audioOnly:
      '<path d="M9 17.6V5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 5.2 16.6 3.4v11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.8" cy="17.6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="14.4" cy="16.6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    // Vídeo: marco con triángulo de reproducción.
    videoFile:
      '<rect x="2.6" y="4.6" width="14.8" height="10.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.6 7.6l4.4 2.4-4.4 2.4z" fill="currentColor"/>',
    // Archivo: documento con esquina doblada.
    file:
      '<path d="M6.2 3h5.6l4 4v9.4a1.2 1.2 0 0 1-1.2 1.2H6.2a1.2 1.2 0 0 1-1.2-1.2V4.2A1.2 1.2 0 0 1 6.2 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11.8 3v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    // Lupa (búsqueda inversa): círculo + mango, estilo Lucide.
    search:
      '<circle cx="9" cy="9" r="5.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13.2 13.2 17 17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    // Copiar: dos rectángulos superpuestos (portapapeles).
    copy:
      '<rect x="6.5" y="6.5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 4.5H5.5a1.6 1.6 0 0 0-1.6 1.6v8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  };
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" focusable="false" aria-hidden="true">${paths[name] || paths.download}</svg>`;
}

// --- Búsqueda inversa de imagen ---
// Motores que aceptan una URL pública de imagen como parámetro (sin API key).
const SEARCH_ENGINES = [
  { name: "Google Lens", url: (u) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}` },
  { name: "Yandex", url: (u) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}` },
  { name: "SauceNAO", url: (u) => `https://saucenao.com/search.php?url=${encodeURIComponent(u)}` },
  { name: "TinEye", url: (u) => `https://tineye.com/search?url=${encodeURIComponent(u)}` },
  { name: "trace.moe", url: (u) => `https://trace.moe/?url=${encodeURIComponent(u)}` },
  { name: "IQDB", url: (u) => `https://iqdb.org/?url=${encodeURIComponent(u)}` },
];

function openSearchEngine(engine, imageUrl) {
  try {
    chrome.runtime.sendMessage({ type: "open-tab", url: engine.url(imageUrl) }).catch(() => {
      window.open(engine.url(imageUrl), "_blank", "noopener");
    });
  } catch {
    window.open(engine.url(imageUrl), "_blank", "noopener");
  }
}

// Sube una imagen (blob) a un alojamiento efímero anónimo para el caso B
// (frames capturados / imágenes sin URL pública). LITTERBOX (catbox temporal):
// POST multipart simple, sin registro, los archivos expiran en 1h. El fetch
// se hace en el SERVICE WORKER (mensaje upload-tmp): desde el content script
// muere por CORS/CSP de la página ("failed to fetch"), mientras que el SW con
// <all_urls> no tiene CORS.
//
// El resultado se recibe por el sendResponse del SW (canal estándar MV3,
// el mismo que usa sw-fetch-blob).
async function uploadToTmpHost(blob) {
  // base64 (no ArrayBuffer/Uint8Array): es lo ÚNICO que serializa de forma
  // fiable content->SW en MV3 (los ArrayBuffer llegan como {}, los Uint8Array
  // a veces como objeto plano que el SW debe reconstruir). Un frame PNG es
  // ~1MB -> ~1.4MB en base64, muy por debajo del límite de 64MiB por mensaje.
  const b64 = await blobToBase64(blob);
  const res = await chrome.runtime.sendMessage({
    type: "upload-tmp",
    data: b64,
    mime: blob.type || "image/png",
    filename: "frame.png",
  });
  if (!res?.ok || !res.url) throw new Error(res?.error || "No se pudo subir la imagen");
  return res.url;
}

// Blob -> data URL base64 (sin el prefijo), por chunks para no reventar la pila.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(blob);
  });
}

// Popover inteligente: se posiciona respecto al botón ancla, abriéndose hacia
// arriba si no hay espacio abajo, y alineado a la derecha si no hay espacio
// a la izquierda. Cierra con click fuera, Escape o al elegir una opción.
// CRÍTICO: un único par de listeners de documento, añadidos UNA vez, que
// consultan el popover actual (ntPopover). Así no quedan listeners huérfanos
// de aperturas anteriores que cierren el popover nuevo (bug "solo funciona
// la primera vez").
let ntPopover = null;

function closeNtPopover() {
  if (ntPopover && ntPopover.isConnected) {
    ntPopover.removeAttribute("data-anchored");
    ntPopover.remove();
  }
  ntPopover = null;
}

// Listener único de cierre (click fuera / Escape). Se añade una sola vez.
function ntPopoverDocHandler(ev) {
  const pop = ntPopover;
  if (!pop) return;
  if (ev.type === "keydown") {
    if (ev.key === "Escape") {
      closeNtPopover();
      return;
    }
    return;
  }
  // pointerdown (cubre mousedown/touch): cerrar solo si el puntero está fuera
  // del popover Y fuera del ancla. El ancla es el botón que abrió el popover
  // (se guarda al abrir). No usar click: un mousedown dentro y mouseup fuera
  // no debe cerrar el menú (ni el botón ancla puede re-abrirlo por duplicado).
  //
  // Robustez: algunos entornos (automatización, toques) emiten un pointerdown
  // en un punto que cae DENTRO del popover pero cuyo ev.target es un elemento
  // intermedio (o el popover acaba de moverse). Comprobar también la posición
  // del puntero respecto al rect del popover y del overlay.
  if (ev.target instanceof Node && pop.contains(ev.target)) return;
  if (ntPopoverAnchor && ev.target instanceof Node && ntPopoverAnchor.contains(ev.target)) return;
  if (typeof ev.clientX === "number") {
    if (overlayInPopover(ev.clientX, ev.clientY)) return;
    const ov = pageOverlay;
    if (ov && !ov.hidden && ov.isConnected) {
      const r = ov.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && inRect(ev.clientX, ev.clientY, r)) return;
    }
  }
  closeNtPopover();
}
let ntPopoverAnchor = null;
document.addEventListener("pointerdown", ntPopoverDocHandler, true);
document.addEventListener("keydown", ntPopoverDocHandler, true);

function openNtPopover(anchor, buildContent) {
  closeNtPopover();
  ntPopoverAnchor = anchor;
  const pop = document.createElement("div");
  pop.id = "nt-popover";
  pop.className = "nt-popover";
  buildContent(pop);
  document.documentElement.appendChild(pop);
  ntPopover = pop;
  // Posicionamiento adaptativo (getBoundingClientRect del ancla y viewport).
  // En modo nativo, el popover se ancla al OVERLAY DE ICONOS (pageOverlay),
  // NO a la imagen/vídeo: así queda justo debajo de los botones, como el
  // fallback JS. El overlay ya sigue a la imagen con anchor(), y el popover
  // sigue al overlay con su propio position-anchor + position-try-fallbacks.
  const ar = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MARGIN = 8;
  let top = ar.bottom + MARGIN;
  let left = ar.left;
  if (top + pr.height > vh - MARGIN) top = ar.top - pr.height - MARGIN; // abrir hacia arriba
  if (left + pr.width > vw - MARGIN) left = ar.right - pr.width; // alinear a la derecha
  // px enteros: evita jitter subpixel al renderizar.
  pop.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
  pop.style.left = `${Math.round(Math.max(MARGIN, left))}px`;
  // Modo nativo: delegar el posicionamiento y el reposicionamiento en bordes
  // a la API nativa, anclando al OVERLAY DE ICONOS (no a la imagen). El
  // top/left inline del fallback JS se limpia (lo controla el CSS).
  if (supportsAnchorPositioning && pageOverlay && !pageOverlay.hidden) {
    const anchorName = overlayAnchorNameFor(pageOverlay);
    pop.style.removeProperty("top");
    pop.style.removeProperty("left");
    pop.style.setProperty("position-anchor", anchorName);
    pop.setAttribute("data-anchored", "1");
  }
}

function searchMenuFor(imageUrl, sourceEl) {
  openNtPopover(sourceEl, (pop) => {
    const title = document.createElement("div");
    title.className = "nt-pop-title";
    title.textContent = "Buscar imagen similar";
    pop.appendChild(title);
    const list = document.createElement("div");
    list.className = "nt-pop-list";
    for (const eng of SEARCH_ENGINES) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "nt-pop-item";
      item.textContent = eng.name;
      item.addEventListener("click", () => {
        closeNtPopover();
        openSearchEngine(eng, imageUrl);
      });
      list.appendChild(item);
    }
    pop.appendChild(list);
  });
}

// Copiar una imagen (URL o blob) al portapapeles como PNG (máxima compatibilidad).
async function copyImageToClipboard(imgEl) {
  try {
    let blob;
    if (imgEl instanceof HTMLCanvasElement) {
      blob = await new Promise((res) => imgEl.toBlob(res, "image/png"));
    } else {
      // Dibujar el <img> ya cargado en el DOM a un canvas (sin re-fetch, que
      // moriría por CORS en imágenes cross-origin). Si el canvas se contamina
      // (imagen sin CORS del sitio), toBlob falla y se reporta con mensaje claro.
      const w = imgEl.videoWidth || imgEl.naturalWidth || imgEl.width;
      const h = imgEl.videoHeight || imgEl.naturalHeight || imgEl.height;
      if (!w || !h) throw new Error("Sin dimensiones para copiar");
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(imgEl, 0, 0, w, h);
      blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    }
    if (!blob) throw new Error("No se pudo generar el PNG");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch (e) {
    throw new Error(`No se pudo copiar: ${e.message}`);
  }
}

// Caso B: contenido sin URL pública (frame capturado / blob / data:).
// Muestra un aviso transparente de subida temporal; si el usuario prefiere
// no subir, ofrece copiar al portapapeles para pegar manualmente.
function confirmUploadThenSearch(sourceEl, anchor, what) {
  openNtPopover(anchor, (pop) => {
    const title = document.createElement("div");
    title.className = "nt-pop-title";
    title.textContent = `Buscar ${what} similar`;
    pop.appendChild(title);
    const note = document.createElement("div");
    note.className = "nt-pop-note";
    note.textContent = `Para buscar este ${what}, se subirá temporalmente a un servicio de alojamiento de imágenes anónimo (Litterbox, expira en 1h). ¿Continuar?`;
    pop.appendChild(note);
    const row = document.createElement("div");
    row.className = "nt-pop-row";
    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "nt-pop-item nt-pop-primary";
    uploadBtn.textContent = "Subir y buscar";
    uploadBtn.addEventListener("click", async () => {
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Subiendo…";
      try {
        const blob = await captureElementToPng(sourceEl);
        const hosted = await uploadToTmpHost(blob);
        closeNtPopover();
        searchMenuFor(hosted, anchor);
      } catch (e) {
        uploadBtn.disabled = false;
        uploadBtn.textContent = "Subir y buscar";
        toastMsg(e.message || "No se pudo subir");
      }
    });
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "nt-pop-item";
    copyBtn.textContent = "Copiar al portapapeles";
    copyBtn.addEventListener("click", async () => {
      try {
        const blob = await captureElementToPng(sourceEl);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        closeNtPopover();
        toastMsg("Fotograma copiado — pégalo en el buscador");
      } catch (e) {
        toastMsg(e.message || "No se pudo copiar");
      }
    });
    row.append(uploadBtn, copyBtn);
    pop.appendChild(row);
  });
}

// Captura un elemento (img o video) a un blob PNG, para subir o copiar.
async function captureElementToPng(sourceEl) {
  if (sourceEl instanceof HTMLCanvasElement) {
    return new Promise((res) => sourceEl.toBlob(res, "image/png"));
  }
  // Para <video>: si aún no decodificó (videoWidth 0 o sin frame), esperar a
  // que esté listo para capturar un frame real, no un canvas negro/vacío.
  let w = sourceEl.videoWidth || sourceEl.naturalWidth || sourceEl.width;
  let h = sourceEl.videoHeight || sourceEl.naturalHeight || sourceEl.height;
  if (sourceEl instanceof HTMLVideoElement && (!w || !h || sourceEl.readyState < 2)) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("El vídeo tardó demasiado en cargar el frame")), 6000);
      sourceEl.addEventListener("loadeddata", () => { clearTimeout(t); resolve(); }, { once: true });
      if (sourceEl.readyState >= 2) { clearTimeout(t); resolve(); }
      sourceEl.addEventListener("error", () => { clearTimeout(t); reject(new Error("El vídeo no se pudo cargar")); }, { once: true });
      if (sourceEl.paused && !sourceEl.ended) sourceEl.currentTime = sourceEl.currentTime || 0; // forzar decodificación
    });
    w = sourceEl.videoWidth || w;
    h = sourceEl.videoHeight || h;
  }
  if (!w || !h) throw new Error("Sin dimensiones para capturar");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas no disponible");
  ctx.drawImage(sourceEl, 0, 0, w, h);
  return new Promise((res, rej) => {
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob falló"))), "image/png");
  });
}

// Toast breve del overlay (feedback visual de acciones como copiar).
let ntToastTimer = null;
function toastMsg(msg) {
  let el = document.getElementById("nt-overlay-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "nt-overlay-toast";
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(ntToastTimer);
  ntToastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// Botones según el tipo del elemento bajo el ratón (exhaustivo, con iconos).
function overlayButtonsFor(el) {
  const btns = [];
  const type = overlayTypeOf(el);
  let url = overlayUrlOf(el);
  // blob: en el DOM (MSE, típico de X/Instagram) pero con URL de red real
  // capturada por webRequest: usar ESA (el blob: no es descargable fuera de
  // la página). Búsqueda genérica en el store local, sin lógica de sitio.
  // Descartar INIT SEGMENTS de fMP4 (DASH de X/Instagram): suelen llamarse
  // *init*.mp4 o .m4s y pesan < ~50KB — metadata vacía sin mdat. Elegirlos
  // producía el bug del "vídeo de 786B". Preferir el manifiesto (m3u8/mpd):
  // el SW lo convierte con init+media y verifica el resultado.
  if (url.startsWith("blob:")) {
    let manifest = null;
    let fallback = null;
    for (const it of store.values()) {
      if (it.source === "network" && it.type === "video" && it.url.startsWith("http")) {
        if (/\.(m3u8|mpd)(?:[?#].*)?$/i.test(it.url)) {
          manifest = manifest || it.url;
          continue;
        }
        // Manifiestos aparte; el filtro de init (nombre o tamaño diminuto)
        // solo aplica a URLs de media, no a m3u8/mpd (siempre pequeños).
        const looksLikeInit = /init/i.test(it.url) || (Number.isFinite(it.sizeKB) && it.sizeKB > 0 && it.sizeKB < 50);
        if (looksLikeInit) continue;
        if (/\.(mp4|webm|mov|mkv)(?:[?#].*)?$/i.test(it.url)) {
          url = it.url;
          fallback = fallback || url;
        }
      }
    }
    // Preferir el manifiesto si no hay un directo REAL (no-init).
    if (url.startsWith("blob:") && manifest) url = manifest;
    if (url.startsWith("blob:") && fallback) url = fallback;
  }
  // URL no resoluble: el vídeo blob: no tiene stream de red capturado aún
  // (no se ha reproducido). El botón debe avisar, no mandar el blob: al SW.
  const blobUnresolved = url.startsWith("blob:");
  const isGif = type === "image" && /\.gif($|[?#])/i.test(url);

  if (type === "image") {
    btns.push({
      icon: overlayIcon("image"),
      label: "Descargar imagen",
      action: () => {
        if (!url) return;
        chrome.runtime.sendMessage({ type: "overlay-download", url: overlayBestUrl(url), filename: (el instanceof HTMLImageElement && el.alt) || "" }).catch(() => {});
      },
    });
    btns.push({
      icon: overlayIcon("copy"),
      label: "Copiar imagen",
      noBusy: true, // no marca busy ni oculta el overlay
      action: async () => {
        try {
          const ok = await copyImageToClipboard(el);
          if (ok) toastMsg("Imagen copiada al portapapeles");
        } catch (e) {
          toastMsg(e.message || "No se pudo copiar");
        }
      },
    });
    btns.push({
      icon: overlayIcon("search"),
      label: "Buscar imagen similar",
      popover: true, // abre popover: no marca busy ni oculta el overlay
      action: (sourceEl) => {
        // Caso A: URL pública -> menú directo. Caso B: blob/data -> aviso + subida.
        if (/^https?:/.test(url)) {
          searchMenuFor(url, sourceEl);
        } else {
          confirmUploadThenSearch(el, sourceEl, "imagen");
        }
      },
    });
    if (isGif) {
      // GIF: descargar como GIF (animación) o como VÍDEO (webm).
      btns.push({
        icon: overlayIcon("videoFile"),
        label: "Descargar como vídeo",
        action: () => {
          if (!url) return;
          chrome.runtime.sendMessage({ type: "overlay-download-gif-video", url, filename: (el instanceof HTMLImageElement && el.alt) || "" }).catch(() => {});
        },
      });
      btns.push({
        icon: overlayIcon("frame"),
        label: "Descargar frame actual del GIF",
        action: () => overlayCaptureFrame(el, "image/png"),
      });
    }
  } else if (type === "video") {
    btns.push({
      icon: overlayIcon("download"),
      label: "Descargar vídeo",
      action: () => {
        if (blobUnresolved) {
          // Sin URL de red: pedir al SW que re-consulte (el stream pudo
          // cargarse entre el hover y el click) antes de rendirse.
          chrome.runtime.sendMessage({ type: "overlay-download", url: "", filename: "", kind: "video", blobOnly: true }).catch(() => {});
          return;
        }
        if (!url) return;
        // Primero intentar la descarga DESDE LA PÁGINA (fetch con cookies y
        // Referer de sesión — necesario para CDNs con anti-hotlink como erome,
        // que devuelven 403/410 al SW o al download directo). Si falla, el
        // fallback interno envía overlay-download al SW.
        overlayDownloadInPage(url, "");
      },
    });
    btns.push({
      icon: overlayIcon("audioOnly"),
      label: "Descargar solo el audio",
      action: () => {
        if (!url) return;
        chrome.runtime.sendMessage({ type: "overlay-download-audio", url, filename: "" }).catch(() => {});
      },
    });
    btns.push({
      icon: overlayIcon("frame"),
      label: "Descargar el fotograma actual",
      action: () => overlayCaptureFrame(el, "image/jpeg"),
    });
    btns.push({
      icon: overlayIcon("search"),
      label: "Buscar fotograma similar",
      popover: true, // abre popover: no marca busy ni oculta el overlay
      action: (sourceEl) => {
        // El frame se captura en canvas (sin URL pública): caso B con aviso.
        confirmUploadThenSearch(el, sourceEl, "fotograma");
      },
    });
  } else if (type === "audio") {
    btns.push({
      icon: overlayIcon("audio"),
      label: "Descargar audio",
      action: () => {
        if (!url) return;
        chrome.runtime.sendMessage({ type: "overlay-download", url, filename: "" }).catch(() => {});
      },
    });
  } else if (type === "file") {
    btns.push({
      icon: overlayIcon("file"),
      label: "Descargar archivo",
      action: () => {
        if (!url) return;
        chrome.runtime.sendMessage({ type: "overlay-download", url, filename: "" }).catch(() => {});
      },
    });
  }
  return btns;
}

// Captura el frame actual de un <video>/<img> con canvas y lo descarga.
async function overlayCaptureFrame(el, mime) {
  try {
    const canvas = document.createElement("canvas");
    const w = el.videoWidth || el.naturalWidth || el.width;
    const h = el.videoHeight || el.naturalHeight || el.height;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(el, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
    if (!blob) return;
    const objUrl = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ type: "overlay-download", url: objUrl, filename: `frame-${Date.now()}.${mime === "image/png" ? "png" : "jpg"}` }).catch(() => {});
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  } catch {
    /* canvas no disponible */
  }
}

// Descarga DESDE EL CONTEXTO DE EXTENSIÓN (el SW), nunca desde la página:
// un fetch aquí (content script) comparte la pila de red de la página y queda
// sujeto a CORS real — por eso erome (v15.erome.com) bloqueaba la lectura con
// "ERR_FAILED". El SW con <all_urls> no tiene CORS y declarativeNetRequest le
// inyecta el Referer de la página (regla efímera por descarga). El blob vuelve
// al panel vía download-blob -> chrome.downloads.
// Devuelve una promesa {ok} / {ok:false,error} para el handler capture-in-page.
async function overlayDownloadInPage(url, filename) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "sw-fetch-blob",
      url,
      filename: filename || url.split("/").filter(Boolean).pop() || "descarga",
      pageUrl: location.href, // Referer real de la página (lo usa la regla DNR)
    });
    if (res?.ok) return { ok: true };
    throw new Error(res?.error || "fallback no disponible");
  } catch (e) {
    // Si el SW no pudo (cookies HttpOnly / DNR no aplica), caer al flujo normal
    // del SW (directo/manifiesto/yt-dlp). NUNCA fetch desde content.js.
    chrome.runtime.sendMessage({ type: "overlay-download", url, filename, kind: "video" }).catch(() => {});
    return { ok: false, error: String(e?.message || e) };
  }
}

function showPageOverlay(el) {
  if (!overlayAllowedFor(location)) return;
  if (!overlayTargetEligible(el)) return; // filtros configurables (tamaño/SVG)
  const btns = overlayButtonsFor(el);
  if (!btns.length) return;
  const ov = ensurePageOverlay();
  ov.textContent = "";
  ov.classList.remove("nt-ov-busy");
  // El botón de descarga (el primero, para vídeo) puede mostrar el indicador
  // de motion design compartido (anillo indeterminado → check) durante la
  // descarga, en vez del icono estático + giro genérico.
  for (let i = 0; i < btns.length; i++) {
    const b = btns[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nt-ov-btn";
    btn.title = b.label; // tooltip NATIVO del navegador (sin duplicados custom)
    btn.setAttribute("aria-label", b.label);
    // Acción principal sugerida: el primer botón (descargar) con tratamiento
    // destacado consistente (fondo morado suave + texto blanco).
    if (i === 0) btn.classList.add("nt-ov-primary");
    let indicator = null;
    if (i === 0 && window.NTDLIndicator && b.label.startsWith("Descargar")) {
      // Indicador dentro del botón: idle (flecha) → anillo → check.
      indicator = new window.NTDLIndicator(btn, { size: "sm" });
      btn.classList.add("nt-dl-host");
    } else {
      btn.innerHTML = b.icon;
    }
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      // Acciones que abren popover (búsqueda) o copian no deben marcar busy
      // ni ocultar el overlay: se ejecutan y el overlay sigue como estaba.
      if (b.popover || b.noBusy) {
        try {
          b.action(btn);
        } catch (e) {
          /* nunca romper el overlay */
        }
        return;
      }
      // Prevención de errores: marcar el overlay como ocupado (el indicador
      // muestra el anillo de progreso), NO ocultarlo al instante — así el
      // usuario ve el feedback y un segundo click no puede repetir la acción.
      if (ov.classList.contains("nt-ov-busy")) return;
      ov.classList.add("nt-ov-busy");
      if (indicator) {
        indicator.setProgress(undefined); // indeterminado: anillo rotando
      }
      try {
        b.action(btn);
      } catch (e) {
        /* la acción nunca debe romper el overlay */
        if (indicator) indicator.error();
      }
      clearTimeout(overlayHideTimer);
      // Si hay indicador, completar con check antes de ocultar (estado 4:
      // vuelve a idle si el cursor sigue encima — el overlay no desaparece).
      if (indicator) {
        setTimeout(() => {
          indicator.success();
          overlayHideTimer = setTimeout(() => hidePageOverlay(), 1400);
        }, 900);
      } else {
        overlayHideTimer = setTimeout(() => hidePageOverlay(), 900);
      }
    });
    ov.appendChild(btn);
  }
  ov.hidden = false;
  pageOverlayTarget = el;
  overlayShownUrl = overlayUrlOf(el);
  overlayTargetRect = el.getBoundingClientRect();
  if (supportsAnchorPositioning) {
    // Modo nativo: el CSS posiciona el overlay relativo al ancla (top/left
    // con `anchor()`); no hace falta tocar el rect por JS.
    overlayAnchorName = overlayAnchorNameFor(el);
    ov.style.setProperty("position-anchor", overlayAnchorName);
  }
  positionPageOverlay();
}

function positionPageOverlay() {
  if (!pageOverlay || pageOverlay.hidden || !pageOverlayTarget) return;
  // Target desconectado (imagen eliminada del DOM): ocultar en vez de dejar
  // el overlay colgado en una posición muerta (reactividad estricta).
  if (!pageOverlayTarget.isConnected) {
    closeNtPopover();
    hidePageOverlay();
    return;
  }
  const r = pageOverlayTarget.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  // Modo nativo: el CSS posiciona con `anchor(top/left)` en el hilo de
  // composición; los top/left inline del fallback JS NO deben aplicarse.
  if (supportsAnchorPositioning) {
    pageOverlay.style.top = "";
    pageOverlay.style.left = "";
    return;
  }
  // Fallback JS: position: fixed respecto al viewport (no rompe el layout).
  // Redondeo a px ENTEROS: los valores fraccionarios (r.top+10 puede ser
  // 102.875) causan jitter/temblor por renderizado subpixel.
  pageOverlay.style.top = `${Math.round(Math.max(8, r.top + 10))}px`;
  pageOverlay.style.left = `${Math.round(Math.max(8, r.left + 10))}px`;
}

function hidePageOverlay() {
  clearTimeout(overlayHideTimer);
  if (pageOverlay) {
    pageOverlay.hidden = true;
    pageOverlay.textContent = "";
    if (supportsAnchorPositioning) {
      // Limpiar el ancla: el overlay vuelve a estar desvinculado hasta el
      // próximo hover (evita que el CSS intente anclar a un nodo muerto).
      pageOverlay.style.removeProperty("position-anchor");
    }
  }
  pageOverlayTarget = null;
  overlayAnchorName = null;
  overlayShownUrl = "";
  overlayTargetRect = null;
}

// Listener global de hover basado en elementFromPoint (agnóstico de sitio):
// en vez de depender del evento mouseover del elemento (que las UIs nativas
// de reproductores con capas encima — X, Instagram, players custom — pueden
// capturar o redirigir a un div hermano del <video>), se consulta en cada
// movimiento de ratón QUÉ elemento hay bajo el cursor y se sube con closest.
// Esto funciona con cualquier estructura DOM, incluidas las virtualizadas
// (nodos reciclados): no se ata ningún listener a nodos concretos.
let overlayLastX = -1;
let overlayLastY = -1;
let overlayThrottleTimer = null;

function overlayAtPoint(x, y) {
  try {
    return document.elementFromPoint(x, y);
  } catch {
    return null;
  }
}

// Si la UI del sitio captura el punto (un div de controles por encima del
// vídeo), buscar de forma GENÉRICA el <video>/<img>/<audio> cuyo rectángulo
// contiene el punto; si ninguno lo contiene (p. ej. la barra de controles
// sobresale del rect del vídeo escalado con object-fit), usar el más cercano
// al punto. Es una consulta al DOM actual, sin selectores de ningún sitio.
function overlayMediaUnderPoint(x, y) {
  const els = document.querySelectorAll("video, img, audio");
  let best = null;
  let bestDist = Infinity;
  for (const el of els) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
      // Distancia al rect (0 si dentro): para controles fuera del rect.
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = el;
      }
    } catch {
      /* nodo desconectado */
    }
  }
  return best;
}

// Extiende (o reduce) un rect con un margen en px. Para hover tolerante.
function rectExpanded(r, m) {
  return {
    left: r.left - m,
    top: r.top - m,
    right: r.right + m,
    bottom: r.bottom + m,
  };
}

// Punto dentro de un rect (con margen).
function inRect(x, y, r) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// ¿El punto está dentro del rect del popover (con un margen de tolerancia
// para el hueco entre el botón ancla y el menú)? (Si no está en el DOM, false.)
const NT_POPOVER_HOVER_MARGIN = 10;
function overlayInPopover(x, y) {
  const pop = ntPopover;
  if (!pop || !pop.isConnected) return false;
  const r = pop.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return inRect(x, y, rectExpanded(r, NT_POPOVER_HOVER_MARGIN));
}

function handleOverlayMove(x, y) {
  if (!overlayAllowedFor(location)) return;
  // Mientras el overlay esté "ocupado" (acción en curso tras un click),
  // no ocultarlo: el feedback de procesando debe completarse.
  if (pageOverlay && !pageOverlay.hidden && pageOverlay.classList.contains("nt-ov-busy")) return;
  const el = overlayAtPoint(x, y);
  if (!(el instanceof Element)) return;

  // Si el cursor está sobre el propio overlay, mantenerlo (y su popover).
  if (el.closest("#nt-page-overlay")) {
    positionPageOverlay();
    return;
  }
  // Si el cursor está sobre el popover, mantenerlo. El popover suele quedar
  // separado del botón por un margen: al mover el ratón del botón al menú,
  // el punto cae en el hueco. Si el hueco cae dentro del rect EXPANDIDO del
  // popover, seguimos considerándolo "sobre el popover" (hover tolerante).
  if (el.closest("#nt-popover") || overlayInPopover(x, y)) {
    return;
  }

  // El cursor salió del overlay y del popover: cerrar el popover
  // INMEDIATAMENTE (sin delay) — reactividad estricta al salir del hover.
  if (ntPopover) closeNtPopover();

  let target = overlayFindTarget(el);
  if (!target) {
    // La UI del sitio (controles del player) puede estar por encima del vídeo:
    // el punto pertenece a un div de X, no al <video>. Buscar por geometría.
    target = overlayMediaUnderPoint(x, y);
  }
  if (!target) {
    // El cursor salió de todo elemento detectable: ocultar el overlay
    // inmediatamente (reactividad estricta).
    hidePageOverlay();
    return;
  }
  const url = overlayUrlOf(target);
  // Sin URL utilizable (imagen sin src, data: embebida), no mostrar nada.
  // Los blob: SÍ se muestran (vídeos/streams en memoria): el frame por
  // canvas funciona y la descarga se intenta.
  if (!url || url.startsWith("data:")) {
    hidePageOverlay();
    return;
  }
  // Filtros configurables: imágenes demasiado pequeñas o SVG se ignoran
  // (iconos/logos). Configurable desde el panel > Opciones.
  if (!overlayTargetEligible(target)) {
    hidePageOverlay();
    return;
  }
  // Reactividad estricta: si el elemento bajo el cursor CAMBIÓ (nodo distinto,
  // src distinto en el mismo nodo, o rect cambiado — p.ej. la imagen del DOM
  // fue reemplazada), re-crear el overlay con los iconos actuales — nunca
  // quedarse con la versión vieja de la imagen.
  const prevUrl = pageOverlayTarget ? overlayUrlOf(pageOverlayTarget) : "";
  const prevRect = pageOverlayTarget ? pageOverlayTarget.getBoundingClientRect() : null;
  const sameTarget = target === pageOverlayTarget && url === prevUrl;
  if (pageOverlay && !pageOverlay.hidden && !sameTarget) {
    // Oclusión real del NUEVO target (elemento fixed/sticky que lo tapa):
    // no mostrar el overlay sobre un header/modal.
    if (supportsAnchorPositioning && !overlayAnchorVisible(target)) {
      hidePageOverlay();
      return;
    }
    clearTimeout(overlayHideTimer);
    showPageOverlay(target);
    return;
  }
  if (target === pageOverlayTarget && !pageOverlay.hidden) {
    // Modo nativo: comprobar oclusión por otro elemento (header sticky, etc.).
    // position-visibility: anchors-visible ya cubre scroll/clipping; aquí
    // solo el caso de un elemento que se superpone visualmente al ancla.
    if (supportsAnchorPositioning && !overlayAnchorVisible(target)) {
      hidePageOverlay();
      return;
    }
    // Mismo target y misma URL: en fallback JS, re-posicionar si el rect
    // cambió (en modo nativo el CSS lo hace solo, sin tocar el layout).
    if (!supportsAnchorPositioning) {
      const prevR = prevRect || overlayTargetRect;
      const curR = target.getBoundingClientRect();
      if (prevR && (prevR.top !== curR.top || prevR.left !== curR.left)) {
        overlayTargetRect = curR;
        positionPageOverlay();
      }
    }
    return;
  }
  // Nuevo target (overlay oculto o target distinto): comprobar oclusión real.
  if (supportsAnchorPositioning && !overlayAnchorVisible(target)) {
    hidePageOverlay();
    return;
  }
  clearTimeout(overlayHideTimer);
  showPageOverlay(target);
}

// Fallback de oclusión (solo modo nativo): ¿el ancla actual está visible en
// pantalla (no tapada por otro elemento)? position-visibility: anchors-visible
// cubre el caso de scroll/clipping; esto cubre la oclusión por un elemento
// superpuesto (p.ej. un header sticky). Comprobación ligera y CONSERVADORA:
// solo se oculta si el centro del ancla está tapado por un elemento fijo o
// sticky que no es el ancla ni parte del overlay/popover. Un elemento diminuto
// o un acierto ambiguo (vecino) NO ocultan: evitar falsos negativos.
function overlayAnchorVisible(el) {
  if (!el) el = pageOverlayTarget;
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const hit = overlayAtPoint(cx, cy);
  if (!hit) return true; // sin elemento: nada que oculte
  if (hit === el || el.contains(hit) || hit.contains(el)) return true;
  if (hit.closest("#nt-page-overlay") || hit.closest("#nt-popover")) return true;
  // Oclusión real: un elemento fijo/sticky (header, modal) tapa el centro.
  try {
    const pos = getComputedStyle(hit).position;
    if (pos === "fixed" || pos === "sticky") return false;
  } catch {
    /* sin estilo */
  }
  return true;
}

document.addEventListener(
  "mousemove",
  (ev) => {
    overlayLastX = ev.clientX;
    overlayLastY = ev.clientY;
    if (overlayThrottleTimer) return;
    overlayThrottleTimer = setTimeout(() => {
      overlayThrottleTimer = null;
      handleOverlayMove(overlayLastX, overlayLastY);
    }, 60); // throttle ~60ms: suficiente para hover, barato en scroll rápido
  },
  { passive: true }
);

// Al hacer scroll, re-evaluar con las últimas coordenadas (el elemento bajo
// el cursor puede cambiar aunque el ratón no se mueva — p.ej. feeds
// virtualizados que reciclan nodos).
["scroll", "resize"].forEach((evt) =>
  window.addEventListener(
    evt,
    () => {
      if (overlayLastX >= 0 && overlayLastY >= 0 && !overlayThrottleTimer) {
        overlayThrottleTimer = setTimeout(() => {
          overlayThrottleTimer = null;
          handleOverlayMove(overlayLastX, overlayLastY);
        }, 60);
      }
      positionPageOverlay();
    },
    { passive: true, capture: true }
  )
);

// --- Reactividad estricta del overlay ante mutaciones del DOM ---
// Si la imagen bajo el cursor cambia su src/srcset, o el elemento es
// sustituido/eliminado (carouseles, feeds virtualizados, SPAs), los iconos
// deben actualizarse u ocultarse INMEDIATAMENTE, aunque el ratón no se mueva.
// Observador ligero: solo los atributos que afectan a la URL mostrada.
const overlayDomObserver = new MutationObserver(() => {
  if (overlayLastX < 0 || overlayLastY < 0) return;
  if (pageOverlay && !pageOverlay.hidden) {
    // Re-evaluar lo que hay bajo el cursor. Si el target cambió, handleOverlayMove
    // re-crea el overlay (o lo oculta); si sigue igual, se re-posiciona.
    handleOverlayMove(overlayLastX, overlayLastY);
  }
});
overlayDomObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "data-src", "data-lazy-src", "data-original", "href", "style"],
});

// Al terminar una transición de layout (p.ej. el contenedor se re-posiciona),
// re-evaluar con las últimas coordenadas.
document.documentElement.addEventListener("transitionend", (ev) => {
  if (overlayLastX >= 0 && overlayLastY >= 0 && !overlayThrottleTimer) {
    overlayThrottleTimer = setTimeout(() => {
      overlayThrottleTimer = null;
      handleOverlayMove(overlayLastX, overlayLastY);
    }, 60);
  }
});

// Preferencias del overlay (toggle + blacklist).
loadOverlayPrefs();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.overlayEnabled) overlayEnabled = changes.overlayEnabled.newValue !== false;
  if (changes.overlayBlacklist) overlayDomainBlacklist = Array.isArray(changes.overlayBlacklist.newValue) ? changes.overlayBlacklist.newValue : [];
  if (changes.overlayMinSize) {
    const min = Number(changes.overlayMinSize.newValue);
    overlayMinSize = Number.isFinite(min) && min >= 0 ? min : 0;
  }
  if (changes.overlayIgnoreSvg) overlayIgnoreSvg = changes.overlayIgnoreSvg.newValue !== false;
  if (!overlayAllowedFor(location)) hidePageOverlay();
  // Re-evaluar el hover actual: si el target dejó de ser elegible (p.ej. se
  // subió el tamaño mínimo), ocultar el overlay inmediatamente.
  if (pageOverlay && !pageOverlay.hidden && overlayLastX >= 0 && overlayLastY >= 0) {
    handleOverlayMove(overlayLastX, overlayLastY);
  }
});

// Estilos del overlay (aislados con prefijo nt- para no chocar con la página).
// Diseño milimétrico: contenedor compacto, transparencia base, hover estable
// (sin scale que tambalee), animación de pulsación sobria y feedback de acción.
// Incluye el CSS del indicador de descarga compartido (anillo/check/error).
if (!document.getElementById("nt-page-overlay-style")) {
  const style = document.createElement("style");
  style.id = "nt-page-overlay-style";
  style.textContent = (window.NTDLIndicatorCSS ? window.NTDLIndicatorCSS() : "") + `
    /* Modo NATIVO: CSS Anchor Positioning (Chrome 125+).
       El overlay se posiciona relativo al ancla (imagen/vídeo bajo el cursor)
       con anchor() y position-anchor. El motor de renderizado mueve el
       overlay en el mismo hilo de composición que el scroll: sincronización
       perfecta, sin JS en el camino. El offset de 8-10px se aplica con margin
       para no chocar con el top/left del fallback JS (que no debe existir
       aquí). */
    #nt-page-overlay[data-anchored="1"] {
      position: fixed;
      position-anchor: var(--nt-anchor-none); /* se sobreescribe por JS con el nombre real */
      top: anchor(top);
      left: anchor(left);
      margin: 10px 0 0 10px; /* desplazamiento de 8-12px respecto al ancla */
      /* Ocultar automáticamente si el ancla queda fuera del scrollport o
         tapada por overflow (clipping) — comportamiento nativo. */
      position-visibility: anchors-visible;
    }
    /* Fallback: navegadores SIN Anchor Positioning. Se conserva el mecanismo
       JS (getBoundingClientRect + scroll listener) que posiciona el overlay
       con top/left inline. Se resetea el margin del modo nativo (allí el
       offset de 10px ya está en el top/left inline). */
    @supports not (anchor-name: --nt-test) {
      #nt-page-overlay {
        position: fixed;
        top: 8px;
        left: 8px;
        margin: 0;
      }
    }
    #nt-page-overlay {
      z-index: 2147483647;
      display: flex;
      flex-direction: row;
      gap: 6px; /* gap UNIFORME entre todos los botones */
      padding: 4px;
      background: rgba(15, 23, 42, 0.62);
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 7px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      opacity: 0.88;
      transition: opacity 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
    }
    #nt-page-overlay:hover {
      opacity: 1;
      background: rgba(15, 23, 42, 0.88);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    #nt-page-overlay[hidden] { display: none; }
    #nt-page-overlay .nt-ov-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: rgba(226, 232, 240, 0.8);
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    #nt-page-overlay .nt-ov-btn:hover {
      background: rgba(139, 92, 246, 0.45);
      color: #fff;
    }
    #nt-page-overlay .nt-ov-btn:active {
      background: rgba(139, 92, 246, 0.65);
    }
    /* Acción principal sugerida (primer botón, descargar): tratamiento
       destacado consistente con el hover, para guiar al usuario. */
    #nt-page-overlay .nt-ov-btn.nt-ov-primary {
      background: rgba(139, 92, 246, 0.3);
      color: #fff;
    }
    #nt-page-overlay .nt-ov-btn svg {
      display: block;
      width: 15px;
      height: 15px;
    }
    /* Pulsación sobria al hacer click: micro-scale SIMÉTRICO y MONÓTONO
       (sin overshoot ni rebote — el overshoot tambalea el icono). El
       transform-origin centrado evita desplazamiento subpixel. */
    #nt-page-overlay .nt-ov-btn svg {
      transform-origin: center center;
    }
    #nt-page-overlay .nt-ov-btn:active svg {
      animation: nt-ov-press 0.18s cubic-bezier(0.25, 0.1, 0.25, 1);
    }
    @keyframes nt-ov-press {
      0% { transform: scale(1); }
      45% { transform: scale(0.85); }
      100% { transform: scale(1); }
    }
    /* Mientras el overlay está ocupado (descarga en curso), los botones no
       responden a clicks duplicados — SIN rotar los iconos. El anillo de
       progreso del indicador (dl-indicator.js) es lo único que anima. */
    #nt-page-overlay.nt-ov-busy .nt-ov-btn {
      pointer-events: none;
    }
    /* Popover inteligente (búsqueda inversa / confirmación de subida).
       En modo nativo se posiciona relativo al OVERLAY DE ICONOS (--nt-ov-anchor),
       NO a la imagen: queda justo debajo de los botones, como el fallback JS.
       Reposiciona automáticamente cerca de bordes con position-try-fallbacks. */
    #nt-popover[data-anchored="1"] {
      position: fixed;
      position-anchor: --nt-ov-anchor;
      top: anchor(bottom);
      left: anchor(left);
      /* Reposicionamiento automático si no cabe: abrir hacia arriba, o
         alinear a la derecha (misma lógica que el fallback JS). */
      position-try-fallbacks:
        flip-block,
        flip-inline,
        flip-block flip-inline;
      margin: 8px 0 0 0;
      position-visibility: anchors-visible;
    }
    @supports not (anchor-name: --nt-test) {
      #nt-popover {
        position: fixed;
        margin: 0;
      }
    }
    #nt-popover {
      z-index: 2147483646;
      min-width: 160px;
      max-width: 260px;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      padding: 6px;
      font: 12px/1.4 system-ui, sans-serif;
      color: #e2e8f0;
      animation: nt-pop-in 0.12s ease-out;
    }
    @keyframes nt-pop-in {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    #nt-popover .nt-pop-title {
      font-weight: 600;
      color: #cbd5e1;
      padding: 4px 6px 6px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.15);
      margin-bottom: 4px;
    }
    #nt-popover .nt-pop-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    #nt-popover .nt-pop-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 6px 8px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: #e2e8f0;
      font: inherit;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    #nt-popover .nt-pop-item:hover {
      background: rgba(139, 92, 246, 0.35);
      color: #fff;
    }
    #nt-popover .nt-pop-item:disabled {
      opacity: 0.6;
      cursor: default;
    }
    #nt-popover .nt-pop-primary {
      background: rgba(139, 92, 246, 0.4);
      color: #fff;
      font-weight: 600;
    }
    #nt-popover .nt-pop-primary:hover {
      background: rgba(139, 92, 246, 0.55);
    }
    #nt-popover .nt-pop-note {
      padding: 4px 6px 8px;
      color: #94a3b8;
      line-height: 1.45;
    }
    #nt-popover .nt-pop-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    /* Toast del overlay (feedback de copiar / errores). */
    #nt-overlay-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: rgba(15, 23, 42, 0.95);
      color: #e2e8f0;
      font: 12px/1.4 system-ui, sans-serif;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #nt-overlay-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(-4px);
    }
  `;
  document.documentElement.appendChild(style);
}
