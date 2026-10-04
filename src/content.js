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

// ============================================================================
// GUARDIA DE CONTEXTO (auto-reparación ante recargas de la extensión)
// Tras recargar la extensión, las pestañas abiertas conservan content scripts
// de la generación anterior cuyo canal chrome.runtime está MUERTO — toda
// interacción fallaba con "Extension context invalidated". Con la guardia:
//   1. ctxSend() detecta el contexto muerto y lanza un error HUMANO.
//   2. La UI de Operant se retira de la página (DOM puro, sin chrome).
//   3. El SW re-inyecta los content scripts al tocar la pestaña (scripting),
//      y cada nueva generación expulsa a la anterior con __operant-shutdown.
// ============================================================================
const CTX_MSG = "Operant se ha recargado: recarga esta página (F5) para reactivarla aquí.";
let contextDead = false;

function contextIsAlive() {
  if (contextDead) return false;
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

// Envío con guardia: async a propósito — todo fallo de contexto se convierte
// en rechazo con mensaje humano, capturable por .catch y por await por igual.
async function ctxSend(msg) {
  if (!contextIsAlive()) {
    contextDead = true;
    shutdownOperantUI();
    throw new Error(CTX_MSG);
  }
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    if (/Extension context invalidated|Receiving end does not exist/i.test(String(e?.message || e))) {
      contextDead = true;
      shutdownOperantUI();
      throw new Error(CTX_MSG);
    }
    throw e;
  }
}

// Retirada limpia de TODA la UI de Operant en la página (solo DOM: funciona
// aunque el canal chrome esté muerto).
function shutdownOperantUI() {
  try {
    hidePageOverlay();
  } catch {
    /* cierre defensivo */
  }
  for (const id of ["operant-page-overlay", "operant-popover", "operant-overlay-toast"]) {
    document.getElementById(id)?.remove();
  }
  document.getElementById("operant-page-overlay-style")?.remove();
}

// Expulsar generaciones anteriores (reinyección tras recargar la extensión):
// la generación previa —si su código ya soporta el evento— retira su UI y
// queda inerte; el DOM queda limpio para ESTA generación. El listener propio
// se registra DESPUÉS del dispatch para no expulsarnos a nosotros mismos.
try {
  document.dispatchEvent(new CustomEvent("__operant-shutdown"));
} catch {
  /* entornos sin CustomEvent */
}
document.addEventListener("__operant-shutdown", () => {
  contextDead = true;
  shutdownOperantUI();
});

function extOf(url) {
  if (url && url.startsWith("data:image/")) {
    const m = url.match(/^data:image\/([a-zA-Z0-9\+\-]+);/);
    if (!m) return "png";
    const sub = m[1].toLowerCase();
    if (sub === "jpeg") return "jpg";
    if (sub === "svg+xml") return "svg";
    return sub;
  }
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    if (m) return m[1].toLowerCase();

    for (const p of ["format", "fm", "ext", "type", "f", "mime"]) {
      const val = u.searchParams.get(p);
      if (val) {
        const clean = val.replace(/^image\//i, "").toLowerCase();
        if (/^(jpe?g|png|webp|avif|gif|svg)$/i.test(clean)) {
          return clean === "jpeg" ? "jpg" : clean;
        }
      }
    }
  } catch {}
  return "";
}

function domainOf(url) {
  if (url && url.startsWith("data:")) {
    return location.hostname.replace(/^www\./, "") || "inline";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Normaliza a URL absoluta; preserva data:image/ válidas (Google Images, canvas, WebApps).
function normalize(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.startsWith("data:")) {
    if (trimmed.startsWith("data:image/")) {
      // Excluir tracking pixels 1x1, spacers transparentes y data URIs minúsculas (< 250 caracteres)
      if (trimmed.length < 250) return null;
      return trimmed;
    }
    return null;
  }
  try {
    return new URL(trimmed, location.href).href;
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
  "data-thumb",
  "data-thumbnail",
  "data-full-src",
  "data-zoom-src",
  "data-highres",
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
    ctxSend({ type: "media-updated", items: [...store.values()] }).catch(() => {});
  }, 350);
}

function add(url, kind, extra = {}) {
  const normalized = normalize(url);
  if (!normalized) return;
  const isData = normalized.startsWith("data:");
  const key = isData
    ? `data_${normalized.slice(0, 80)}_${normalized.length}_${normalized.slice(-40)}`
    : normalized.split("#")[0];

  const existing = store.get(key);
  if (existing) {
    if (extra.thumb && !existing.thumb) existing.thumb = extra.thumb;
    if (extra.durationSec && !existing.durationSec) existing.durationSec = extra.durationSec;
    if (existing.sizeUnknown === undefined && extra.sizeUnknown) existing.sizeUnknown = true;
    if (extra.w && !existing.w) existing.w = extra.w;
    if (extra.h && !existing.h) existing.h = extra.h;
    if (extra.name && !existing.name) existing.name = extra.name;
    return;
  }
  if (store.size >= MAX_ITEMS) return;

  let sizeBytes = extra.sizeBytes || null;
  if (!sizeBytes && isData) {
    const comma = normalized.indexOf(",");
    if (comma !== -1) {
      sizeBytes = Math.floor((normalized.length - comma - 1) * 0.75);
    }
  }
  if (!sizeBytes && !isData) {
    sizeBytes = perfSizeBytes(normalized);
  }

  const detectedExt = extOf(normalized);
  const fallbackExt = kind === "image" ? "jpg" : kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "";
  const ext = detectedExt || fallbackExt;

  const item = {
    url: normalized,
    type: kind,
    ext,
    domain: domainOf(normalized),
    sizeKB: sizeBytes ? Math.round(sizeBytes / 1024) : null,
    sizeUnknown: !sizeBytes && !isData,
    sizeBytes,
    source: extra.source || "dom",
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
  // 1. Elementos <img> estándar con src, currentSrc y TODOS sus atributos
  for (const img of qsaAll("img")) {
    const extra = {
      w: img.naturalWidth || (img.width > 0 ? img.width : null),
      h: img.naturalHeight || (img.height > 0 ? img.height : null),
      name: img.alt || img.title || null,
    };
    if (img.currentSrc) add(img.currentSrc, "image", extra);
    if (img.src) add(img.src, "image", extra);

    for (const attr of img.attributes) {
      const name = attr.name.toLowerCase();
      if (name === "src" || name === "currentsrc" || name === "alt" || name === "title" || name === "width" || name === "height" || name === "class" || name === "id" || name === "style") continue;
      const value = attr.value?.trim();
      if (!value || value.length < 3) continue;

      if (name.includes("srcset")) {
        for (const c of parseSrcset(value)) add(c, "image", extra);
      } else if (name.startsWith("data-") || value.startsWith("data:image/") || /^(\/|\.\/|\.\.\/|https?:|\/\/)/i.test(value) || EXT_GROUPS.image.test(value)) {
        add(value, "image", extra);
      }
    }
  }

  // 2. <picture><source srcset>
  for (const source of qsaAll("picture source, source")) {
    for (const c of parseSrcset(source.getAttribute("srcset"))) add(c, "image");
    const s = source.getAttribute("src");
    if (s && EXT_GROUPS.image.test(s)) add(s, "image");
  }

  // 3. Elementos SVG con imágenes embebidas (<image href="...">)
  for (const svgImg of qsaAll("svg image, image")) {
    const href = svgImg.getAttribute("href") || svgImg.getAttribute("xlink:href");
    if (href) add(href, "image");
  }

  // 4. Elementos <canvas> con gráficos o renders (visores protegidos, editores, diagramas)
  for (const cvs of qsaAll("canvas")) {
    try {
      if (cvs.width >= 100 && cvs.height >= 100) {
        const dataUrl = cvs.toDataURL("image/png");
        if (dataUrl && dataUrl.length >= 250) {
          add(dataUrl, "image", { w: cvs.width, h: cvs.height, source: "canvas" });
        }
      }
    } catch {}
  }

  // 5. Enlaces <a> que apuntan directamente a imágenes de alta resolución
  for (const a of qsaAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href && EXT_GROUPS.image.test(href)) {
      add(href, "image", { name: a.textContent?.trim() || a.title || null });
    }
  }

  // 6. Meta tags de alta resolución (OpenGraph, Twitter card, canonical poster)
  for (const meta of qsaAll("meta[property='og:image'], meta[property='og:image:secure_url'], meta[name='twitter:image'], meta[name='twitter:image:src'], link[rel='image_src'], link[rel='apple-touch-icon']")) {
    const content = meta.getAttribute("content") || meta.getAttribute("href");
    if (content) add(content, "image");
  }

  // 7. <noscript> con <img> dentro (fallback de lazy-load)
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
      if (url) add(url, "image");
    }
  }
}

// --- Extractor universal de medios anidados en parámetros de enlace (<a href="...?url=...">) ---
// En cualquier visor, agregador o buscador web, los enlaces que envuelven miniaturas contienen
// parámetros que apuntan a la imagen original o de alta resolución en la web de origen.
function scanNestedMediaLinks() {
  for (const a of qsaAll("a[href]")) {
    const rawHref = a.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:") || rawHref.startsWith("mailto:")) continue;

    try {
      const u = new URL(rawHref, location.href);
      for (const [key, val] of u.searchParams.entries()) {
        if (!val || typeof val !== "string" || val.length < 8) continue;

        const isUrlPattern = /^(https?:)?\/\//i.test(val) || /^https?%3A%2F%2F/i.test(val);
        if (!isUrlPattern) continue;

        try {
          const decoded = decodeURIComponent(val);
          const fullUrl = new URL(decoded, location.href).href;
          const kind = classify(fullUrl);

          const isMediaParam = /(imgurl|image|img|pic|photo|media|src|file|thumb|thumbnail|orig|original|target|download)/i.test(key);
          if (kind || isMediaParam) {
            const w = Number(u.searchParams.get("w") || u.searchParams.get("width")) || null;
            const h = Number(u.searchParams.get("h") || u.searchParams.get("height")) || null;
            const label = a.getAttribute("aria-label") || a.title || a.textContent?.trim() || "";
            const innerImg = a.querySelector("img");
            const thumb = innerImg?.currentSrc || innerImg?.src || null;
            add(fullUrl, kind || "image", {
              w,
              h,
              thumb,
              source: "link_param",
              name: label.length > 2 && label.length < 100 ? label : null,
            });
          }
        } catch {}
      }
    } catch {}
  }
}

// --- Extractor universal de atributos profundos y estructuras JSON incrustadas ---
function scanDeepElementAttributes() {
  const elements = qsaAll("figure, [data-src], [data-lazy], [data-original], [data-url], [data-image], [data-full], [data-zoom], [data-highres], [data-thumb], [data-media], [data-sources], [data-meta], [m]");

  for (const el of elements) {
    const innerImg = el.tagName === "IMG" ? el : el.querySelector("img");
    const thumb = innerImg?.currentSrc || innerImg?.src || null;
    for (const attr of el.attributes) {
      const val = attr.value?.trim();
      if (!val || val.length < 8) continue;
      const name = attr.name.toLowerCase();

      if (name === "src" || name === "currentsrc" || name === "srcset") continue;

      if (val.startsWith("data:image/") || /^(https?:)?\/\//i.test(val)) {
        const kind = classify(val);
        if (kind) add(val, kind, { thumb });
        continue;
      }

      if (val.includes(",") && (val.includes(" 1x") || val.includes(" 2x") || val.includes("w,") || val.includes("w "))) {
        for (const c of parseSrcset(val)) add(c, "image", { thumb });
        continue;
      }

      if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith("[") && val.endsWith("]"))) {
        try {
          const parsed = JSON.parse(val);
          extractUrlsFromJson(parsed, { thumb });
        } catch {}
      }
    }
  }
}

function extractUrlsFromJson(obj, extra = {}, depth = 0) {
  if (!obj || depth > 4) return;
  if (typeof obj === "string") {
    if (obj.startsWith("data:image/") || /^(https?:)?\/\//i.test(obj)) {
      const kind = classify(obj);
      if (kind) add(obj, kind, extra);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) extractUrlsFromJson(item, extra, depth + 1);
    return;
  }
  if (typeof obj === "object") {
    const w = Number(obj.width || obj.w) || extra.w || null;
    const h = Number(obj.height || obj.h) || extra.h || null;
    const currentExtra = (w || h) ? { ...extra, w, h } : extra;

    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (/^(https?:)?\/\//i.test(v) || v.startsWith("data:image/"))) {
        const isMediaKey = /(url|src|murl|turl|image|thumb|original|full|poster)/i.test(k);
        const kind = classify(v);
        if (kind || isMediaKey) {
          add(v, kind || "image", currentExtra);
        }
      } else if (typeof v === "object") {
        extractUrlsFromJson(v, currentExtra, depth + 1);
      }
    }
  }
}

// --- Extractor universal de datos estructurados Schema.org / JSON-LD ---
function scanJsonLd() {
  for (const script of qsaAll("script[type='application/ld+json']")) {
    try {
      const content = script.textContent?.trim();
      if (!content) continue;
      const data = JSON.parse(content);
      extractUrlsFromJson(data);
    } catch {}
  }
}

const URL_RE = /url\((["']?)(.*?)\1\)/g;

// --- Progreso real de escaneo (feedback no decorativo en el panel) ---
// Enfocado de forma matemática en candidatos visuales para evitar congelar
// el hilo principal con 30.000+ consultas getComputedStyle en nodos vacíos.
let scanTotal = 0;
let scanDone = 0;
let lastProgressAt = 0;

function reportProgress(force = false, phase = "estilos") {
  const now = Date.now();
  if (!force && now - lastProgressAt < 80) return;
  lastProgressAt = now;
  ctxSend({
    type: "scan-progress",
    done: scanDone,
    total: scanTotal,
    phase: (scanTotal > 0 && scanDone >= scanTotal) ? "done" : phase,
    found: store.size,
  }).catch(() => {});
}

function getBackgroundCandidates() {
  const visualSelectors = [
    "[style*='background']",
    "[style*='url(']",
    "[style*='--']",
    "header", "nav", "section", "article", "aside", "footer", "figure", "main",
    "div[class]", "a[class]", "span[class]", "button[class]", "li[class]"
  ].join(",");

  const rawElements = qsaAll(visualSelectors);
  const ignoredTags = /^(script|style|link|meta|title|head|path|svg|g|circle|rect|polygon|line|br|hr|wbr|option|input|textarea)$/i;
  return rawElements.filter((el) => !ignoredTags.test(el.tagName));
}

function scanBackgroundImages(candidates = null, baseDone = 0, targetTotal = 0) {
  const all = candidates || getBackgroundCandidates();
  if (targetTotal > 0) {
    scanTotal = targetTotal;
    scanDone = baseDone;
  } else {
    scanTotal = all.length;
    scanDone = 0;
  }
  reportProgress(false, "estilos");
  let i = 0;
  function step() {
    const end = Math.min(i + 200, all.length);
    for (; i < end; i++) {
      try {
        const bg = getComputedStyle(all[i]).backgroundImage;
        if (!bg || bg === "none") continue;
        let m;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(bg))) {
          if (m[2]) add(m[2], "image");
        }
      } catch {}
    }
    scanDone = baseDone + end;
    if (i < all.length) {
      reportProgress(false, "estilos");
      if ("requestIdleCallback" in window) requestIdleCallback(step, { timeout: 40 });
      else setTimeout(step, 40);
    } else {
      scanDone = scanTotal;
      reportProgress(true, "done");
      notify();
    }
  }
  if (all.length > 0) step();
  else {
    scanDone = scanTotal;
    reportProgress(true, "done");
    notify();
  }
}

// ============================================================================
// FASES DE EXHAUSTIVIDAD EXTRA (clase ImageEye)
// El escaneo DOM/computed-style se queda corto (~350 en páginas con ~1000
// medios reales). Estas tres fases cubren lo que ningún selector alcanza:
//   1. Resource Timing: TODO recurso ya cargado por el navegador (imgs
//      perezosas fuera del DOM, fondos CSS, <link rel=preload>, respuestas
//      fetch/XHR) — sin peticiones extra.
//   2. Reglas CSS completas: url(...) en reglas no aplicadas aún (@media,
//      :hover, ::before/::after, @keyframes) que getComputedStyle no ve.
//   3. Barrido textual del HTML: cualquier URL de medio embebida en
//      preload/microdata/JSON de scripts/atributos arbitrarios.
// ============================================================================

// 1. Recursos registrados por el navegador (Performance API).
function scanResourceTiming() {
  let entries = [];
  try {
    entries = performance.getEntriesByType("resource");
  } catch {
    return;
  }
  for (const e of entries) {
    const url = e.name || "";
    if (!/^https?:/i.test(url)) continue;
    const kind = classify(url);
    if (kind) add(url, kind, { source: "resource" });
  }
}

// 2. url(...) en todas las reglas CSS accesibles (recursivo: media/supports/
// keyframes contienen reglas de estilo anidadas).
function collectCssRuleUrls(rules) {
  for (const rule of rules) {
    try {
      if (rule.type === 1 /* STYLE_RULE */) {
        const text = rule.cssText || "";
        if (!text.includes("url(")) continue;
        let m;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(text))) {
          if (m[2] && !m[2].startsWith("data:")) add(m[2], "image");
        }
      } else if (rule.cssRules) {
        collectCssRuleUrls(rule.cssRules);
      }
    } catch {
      /* regla malformada */
    }
  }
}

function scanStylesheetUrls() {
  for (const sheet of document.styleSheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sin CORS: cubierto por webRequest
    }
    if (rules) collectCssRuleUrls(rules);
  }
}

// 3. Barrido textual del HTML (limitado: como mucho una vez cada 5s, es la
// fase más pesada y el MutationObserver re-dispara fullScan a menudo).
let lastTextScanAt = 0;

function scanDocumentTextUrls() {
  const now = Date.now();
  if (now - lastTextScanAt < 5000) return;
  lastTextScanAt = now;
  const html = document.documentElement.outerHTML || "";
  if (!html || html.length > 12e6) return; // cota de seguridad en páginas enormes
  const re = /https?:\/\/[^\s"'<>`\\)]+/g;
  let m;
  let hits = 0;
  while ((m = re.exec(html))) {
    const kind = classify(m[0]);
    if (kind) {
      add(m[0], kind, { source: "html" });
      if (++hits >= 4000) break;
    }
  }
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
  // 1. Si la propia página actual es un vídeo de plataforma (YouTube, Vimeo, Dailymotion, etc.),
  // registrar el vídeo canónico con su título real, thumbnail y método embed (para yt-dlp).
  const pageEmbed = embedInfo(location.href);
  if (pageEmbed) {
    let title = (document.title || "").replace(/\s*-\s*YouTube$/i, "").trim() || "Vídeo de YouTube";
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    if (ogTitle) title = ogTitle;
    const currentVideoEl = document.querySelector("video");
    const durSec = currentVideoEl?.duration;
    add(location.href, "video", {
      name: title,
      title: title,
      embed: pageEmbed.platform,
      embedId: pageEmbed.id,
      thumb: pageEmbed.thumb || (pageEmbed.id ? `https://i.ytimg.com/vi/${pageEmbed.id}/hqdefault.jpg` : null),
      method: "embed",
      source: "page",
      durationSec: durSec && isFinite(durSec) ? durSec : null,
      w: currentVideoEl?.videoWidth || null,
      h: currentVideoEl?.videoHeight || null,
    });
    if (pageEmbed.id) {
      add(`https://i.ytimg.com/vi/${pageEmbed.id}/maxresdefault.jpg`, "image", { name: `${title} (portada 1080p)` });
      add(`https://i.ytimg.com/vi/${pageEmbed.id}/hqdefault.jpg`, "image", { name: `${title} (portada)` });
    }
  }

  // 2. En YouTube/plataformas de vídeo: detectar enlaces a otros vídeos visibles (feed, recomendaciones)
  if (/youtube\.com/i.test(location.hostname)) {
    for (const a of qsaAll("a[href*='/watch?v='], a[href*='/shorts/']")) {
      const href = a.href;
      const emb = embedInfo(href);
      if (emb && emb.id) {
        const linkTitle = a.getAttribute("title") || a.getAttribute("aria-label") || (a.textContent || "").trim();
        if (linkTitle.length > 3) {
          add(href, "video", {
            name: linkTitle,
            title: linkTitle,
            embed: "youtube",
            embedId: emb.id,
            thumb: emb.thumb,
            method: "embed",
            source: "page",
          });
          if (emb.thumb) {
            add(emb.thumb, "image", { name: `${linkTitle} (miniatura)` });
          }
        }
      }
    }
  }

  // 3. Vídeos estándar HTML5 en el DOM
  for (const v of qsaAll("video")) {
    const src = v.currentSrc || v.getAttribute("src");
    // En YouTube: ignorar blob: efímeros del reproductor nativo porque ya tenemos la URL canónica arriba
    if (pageEmbed && src && src.startsWith("blob:")) continue;

    const extra = {
      durationSec: v.duration && isFinite(v.duration) ? v.duration : null,
      w: v.videoWidth || null,
      h: v.videoHeight || null,
      thumb: v.poster && v.poster.startsWith("http") ? v.poster : null,
    };
    if (src) add(src, "video", extra);
    if (v.poster) add(v.poster, "image");

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
  attributeFilter: ["src", "srcset", "data-src", "data-lazy-src", "data-original", "data-url", "data-image", "style", "href", "poster"],
};

// Nodos de la PÁGINA sobre los que Operant escribe atributos (hoja de estilos
// inline). Un WeakSet: no mantiene referencias fuertes, así que no puede
// impedir la recolección de los nodos. Existe para el filtro del observer: si
// el observer se disparara por estas escrituras propias, escribir el
// `anchor-name` de un elemento provocaría un re-escaneo completo, que volvería
// a escribir el `anchor-name`… bucle infinito.
const operantMutatedPageNodes = new WeakSet();

// ¿El nodo (o su ancestro más cercano) pertenece a la UI propia de Operant
// (overlay, popover, toast, hoja de estilos)?
//
// Imprescindible en cuanto se observa `document`: los nodos de Operant viven
// dentro del árbol observado y el overlay escribe `style.top`/`style.left` en
// CADA mousemove. Sin este filtro, cada movimiento del ratón generaría una
// mutación que dispararía un re-escaneo completo, que a su vez recolocaría el
// overlay... es decir, un bucle de realimentación que deja la página
// inutilizable.
function isOwnUiNode(node) {
  let el = node;
  if (el && el.nodeType !== 1) el = el.parentElement; // nodos de texto
  let hops = 0;
  while (el && hops++ < 8) {
    const id = el.id || "";
    if (id.startsWith("operant-")) return true;
    const cls = typeof el.className === "string" ? el.className : "";
    if (cls && cls.split(/\s+/).some((c) => c.startsWith("operant-"))) return true;
    el = el.parentElement;
  }
  return false;
}

// El observer de re-escaneo debe ignorar tanto los nodos propios como los
// nodos de la página en los que Operant escribe estilos.
function isOperantOwnMutation(target) {
  if (!target) return false;
  if (operantMutatedPageNodes.has(target)) return true;
  return isOwnUiNode(target);
}

// Detectar contenido cargado dinámicamente (infinite scroll, SPAs).
const observer = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === "attributes") {
      if (isOperantOwnMutation(r.target)) continue;
    } else {
      const touched = [...r.addedNodes, ...r.removedNodes];
      if (touched.length > 0 && touched.every((n) => isOperantOwnMutation(n))) continue;
    }
    scheduleRescan();
    return; // una sola señal basta: no hace falta recorrer el resto
  }
});
const observedRoots = new Set();

function ensureObserved() {
  // `document` es la raíz OBLIGATORIA y es la que faltaba. Sin ella, el
  // observer solo veía shadow roots abiertos y documentos de iframe
  // same-origin, así que en cualquier página sin esos nodos no observaba
  // NADA: infinite scroll, rutas de SPA y feeds virtualizados (que viven en el
  // light DOM) no provocaban ningún re-escaneo automático. Solo se observan
  // raíces accesibles: los shadow roots cerrados y los iframes cross-origin no
  // lo son por diseño de la plataforma.
  for (const root of [document, ...allShadowRoots(), ...allIframeDocs()]) {
    if (!root || observedRoots.has(root)) continue;
    observedRoots.add(root);
    try {
      observer.observe(root, OBSERVER_OPTS);
    } catch {
      observedRoots.delete(root); // raíz ya desconectada: no insistimos
    }
  }
  // Podar raíces desconectadas. `observedRoots` es un Set de referencias
  // FUERTES: sin poda, cada ruta SPA que monta y desmonta un web component, y
  // cada navegación de iframe same-origin (que crea un Document nuevo), deja
  // una entrada más y un observer vivo sobre un árbol que ya no existe.
  if (observedRoots.size > 32) {
    for (const root of [...observedRoots]) {
      if (root === document) continue;
      if (root.isConnected === false) {
        observedRoots.delete(root);
        try {
          observer.unobserve(root);
        } catch {
          /* ya no estaba observando */
        }
      }
    }
  }
}

function fullScan() {
  const domImgCount = qsaAll("img, picture source, svg image, canvas, meta[property*='image']").length;
  const linkCount = qsaAll("a[href]").length;
  const deepCount = qsaAll("figure, [data-src], [data-lazy], [data-original], [data-url], [data-image], [data-full], [data-zoom], [data-highres], [data-thumb], [data-media], [data-sources], [data-meta], [m], script[type='application/ld+json']").length;
  const mediaCount = qsaAll("video, audio, object, embed, iframe").length;
  const bgCandidates = getBackgroundCandidates();
  const bgCount = bgCandidates.length;

  scanTotal = domImgCount + linkCount + deepCount + mediaCount + bgCount;
  scanDone = 0;
  reportProgress(true, "inicio");

  // Fase 1: Elementos visuales DOM
  scanImages();
  scanDone += domImgCount;
  reportProgress(true, "imágenes");

  // Fase 2: Enlaces con parámetros anidados y alta resolución
  scanNestedMediaLinks();
  scanDone += Math.round(linkCount / 2);
  reportProgress(true, "enlaces");

  // Fase 3: Atributos profundos, visores dinámicos y JSON-LD
  scanDeepElementAttributes();
  scanJsonLd();
  scanDone += deepCount;
  reportProgress(true, "atributos");

  // Fase 4: Descargas directas y elementos multimedia (vídeo/audio/embeds)
  scanDownloadLinks();
  scanVideosAndAudio();
  scanDone += (linkCount - Math.round(linkCount / 2)) + mediaCount;
  reportProgress(true, "medios");

  // Fase 5: exhaustividad extra (clase ImageEye) — recursos del navegador,
  // reglas CSS completas y barrido textual del HTML. Baratos y deduplicados
  // por el store; el textual va limitado a una pasada cada 5s.
  scanResourceTiming();
  scanStylesheetUrls();
  scanDocumentTextUrls();
  scanDone += 1;
  scanTotal += 1;
  reportProgress(true, "recursos");

  // Fase 6: Estilos y fondos CSS con fluid steps
  const baseDone = scanDone;
  scanBackgroundImages(bgCandidates, baseDone, scanTotal);

  ensureObserved(); // vigilar también los shadow roots descubiertos
  notify();
}

let rescanTimer = null;
let rescanFirstPendingAt = 0;
// Backoff ADAPTATIVO del re-escaneo (genérico, sin listas de sitios): en
// páginas con tormentas de mutaciones (lightboxes, carruseles, feeds
// virtualizados) el re-escaneo a intervalo fijo consumía CPU y saturaba la
// tubería. Si un re-escaneo no aporta items nuevos, se duplica el intervalo
// (800ms → 6.4s máx.); con novedad, vuelve al inmediato.
let rescanBackoffMs = 800;
let lastRescanStoreSize = -1;
// Duración real del último fullScan. Se usa para poner un TECHO ADAPTATIVO al
// tiempo entre escaneos: es lo que hace seguro observar `document`.
let lastScanMs = 0;
// Techo base entre escaneos cuando el escaneo es barato.
const RESCAN_MIN_WAIT_MS = 2000;

function scheduleRescan() {
  const now = Date.now();
  if (!rescanFirstPendingAt) rescanFirstPendingAt = now;

  // Un debounce puro es INSUFICIENTE ahora que se observa `document`: cualquier
  // página que mute `style` de forma continua (carrusel con autoplay, barra de
  // progreso de vídeo, runtime CSS-in-JS) reinicia el temporizador para siempre
  // y `fullScan()` no llega a ejecutarse ni una sola vez.
  //
  // El techo se calcula a partir del COSTE REAL de la última pasada: no se
  // permite gastar más del ~50 % del tiempo de reloj escaneando. Con un escaneo
  // de 50 ms el techo es el mínimo (2 s); con uno de 6 s (página grande) el
  // techo sube a 12 s en lugar de provocar un escaneo cada 2 s y bloquear la
  // página. Así el re-escaneo nunca es la causa de que la web se sienta lenta.
  const maxWait = Math.min(15000, Math.max(RESCAN_MIN_WAIT_MS, lastScanMs * 2));
  const waited = now - rescanFirstPendingAt;
  const delay = Math.max(0, Math.min(rescanBackoffMs, maxWait - waited));

  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanFirstPendingAt = 0;
    const before = store.size;
    const t0 = performance.now();
    fullScan();
    lastScanMs = performance.now() - t0;
    ensureObserved();
    if (store.size === before && before === lastRescanStoreSize) {
      rescanBackoffMs = Math.min(6400, rescanBackoffMs * 2);
    } else {
      rescanBackoffMs = 800;
    }
    lastRescanStoreSize = store.size;
  }, delay);
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

// Eventos de navegación SPA en YouTube y sitios dinámicos
window.addEventListener("yt-navigate-finish", () => {
  setTimeout(() => {
    fullScan();
    ensureObserved();
  }, 400);
});
window.addEventListener("popstate", () => {
  setTimeout(() => {
    fullScan();
    ensureObserved();
  }, 400);
});

// --- Auto-scroll activo (estilo ImageEye) ---
// Recorre la página hacia abajo en saltos de viewport, espera a que el
// lazy-load dispare, re-escanea y repite hasta el final del scrollHeight.
// Con cancelación y devolución del scroll a su posición original.

let activeScan = null; // { cancelled: boolean, originalScrollY }

const SCROLL_STEP_WAIT = 400; // ms de espera tras cada salto (lazy-load)

function scanProgressMsg(done, total, phase) {
  ctxSend({ type: "scan-progress", done, total, phase }).catch(() => {});
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
  if (msg?.type === "rec-start" || msg?.type === "rec-stop" || msg?.type === "rec-cancel") {
    // Puente SW → recorder (mundo MAIN) vía postMessage entre mundos.
    const cmd = msg.type === "rec-start" ? "start" : msg.type === "rec-stop" ? "stop" : "cancel";
    const installed = !!window.__operantRecorderInstalled && window.__operantRecEpoch === REC_EPOCH;
    if (installed) {
      window.postMessage({ __operantRecCmd: true, cmd, epoch: REC_EPOCH }, "*");
    }
    sendResponse({ ok: true, installed });
    return;
  }
});

// --- Puente del modo grabación: recorder (mundo MAIN) → SW ---
// Todos los mensajes del recorder llevan __operantRec y EPOCH (solo se
// retransmite la generación vigente; las entregas de generaciones huérfanas
// se descartan). Los comandos del otro sentido llevan __operantRecCmd.
const REC_EPOCH = "r2"; // mantener en sincronía con recorder-main.js

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || !msg.__operantRec || msg.epoch !== REC_EPOCH) return;
  ctxSend({ type: "rec-relay", payload: msg }).catch(() => {});
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
{
  // La primera pasada fija la escala del techo adaptativo de scheduleRescan:
  // sin ella, el primer re-escaneo usaría el mínimo (2 s) aunque la página sea
  // lo bastante grande como para que un escaneo completo tarde segundos.
  const t0 = performance.now();
  fullScan();
  lastScanMs = performance.now() - t0;
}
console.log("[operant-content] tras fullScan inicial:", store.size, "items en", location.href);

// Handshake: el SW puede haber capturado streams (m3u8/mpd/ts) antes de que
// este content script se inyectara; se los pedimos para no perderlos.
setTimeout(() => {
  ctxSend({ type: "content-ready" }).catch(() => {});
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
  // Las imágenes pequeñas (iconos, avatares, badges, botones <120px) nunca deben activar el hover overlay.
  const effectiveMin = overlayMinSize > 0 ? overlayMinSize : 120;
  const r = el.getBoundingClientRect();

  // Si no está renderizado o sus dimensiones en pantalla son menores al umbral, descartar
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.width < effectiveMin || r.height < effectiveMin) return false;

  if (el instanceof HTMLImageElement) {
    // Si las dimensiones intrínsecas de la imagen son menores al umbral, descartar
    if (el.naturalWidth > 0 && el.naturalWidth < effectiveMin) return false;
    if (el.naturalHeight > 0 && el.naturalHeight < effectiveMin) return false;

    // Descartar favicons, avatares e iconos por heurística de URL
    const src = (el.currentSrc || el.src || "").toLowerCase();
    if (/(avatar|favicon|\/icon|badge|emoji)/i.test(src)) {
      if (r.width < 160 || r.height < 160) return false;
    }
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
// puede desactivarlo con <html data-operant-no-anchors> (lo lee el content script).
const supportsAnchorPositioning =
  typeof CSS !== "undefined" &&
  !!CSS.supports &&
  CSS.supports("anchor-name", "--operant-test") &&
  !(document.documentElement && document.documentElement.hasAttribute("data-operant-no-anchors"));
// Nombre de ancla del target actual (solo en modo nativo). Se asigna al
// elemento detectado bajo el cursor y lo referencia el overlay.
let overlayAnchorName = null;
let overlayAnchorSeq = 0; // para generar nombres únicos por elemento
const overlayAnchorCache = new WeakMap(); // elemento -> anchor-name (no re-asignar si sigue siendo el mismo)

function ensurePageOverlay() {
  if (pageOverlay) return pageOverlay;
  pageOverlay = document.createElement("div");
  pageOverlay.id = "operant-page-overlay";
  pageOverlay.setAttribute("data-operant", "1");
  // Modo nativo: atributo para que el CSS aplique el posicionamiento por ancla.
  if (supportsAnchorPositioning) pageOverlay.setAttribute("data-anchored", "1");
  // El propio overlay actúa como ancla del popover (el popover se abre debajo
  // de los iconos). Nombre fijo: el popover lo referencia como --operant-ov-anchor.
  try {
    pageOverlay.style.setProperty("anchor-name", "--operant-ov-anchor");
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
  const name = `--operant-anchor-${++overlayAnchorSeq}`;
  overlayAnchorCache.set(el, name);
  try {
    // Se registra ANTES de escribir: el observer ignora este nodo para no
    // encadenar un re-escaneo completo con nuestra propia escritura de estilo.
    operantMutatedPageNodes.add(el);
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

// Iconos del overlay: sistema NORMALIZADO compartido (shared/icons.js,
// rejilla Lucide 24×24, trazo 1.75 — la misma geometría exacta que el panel).
// Alias semánticos del overlay → nombres del set.
const OVERLAY_ICON_ALIASES = {
  download: "download",
  frame: "camera",
  image: "image",
  audio: "music",
  audioOnly: "headphones",
  videoFile: "video",
  file: "file",
  search: "search",
  copy: "copy",
};

function overlayIcon(name) {
  const I = window.OperantIcons || window.NTIcons;
  if (I) return I.svg(OVERLAY_ICON_ALIASES[name] || name, 15);
  return ""; // sin sistema de iconos no se pinta un sustituto tipográfico
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
    ctxSend({ type: "open-tab", url: engine.url(imageUrl) }).catch(() => {
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
  const res = await ctxSend({
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
// consultan el popover actual (operantPopover). Así no quedan listeners huérfanos
// de aperturas anteriores que cierren el popover nuevo (bug "solo funciona
// la primera vez").
let operantPopover = null;

function closeOperantPopover() {
  if (operantPopover && operantPopover.isConnected) {
    operantPopover.removeAttribute("data-anchored");
    operantPopover.remove();
  }
  operantPopover = null;
}

// Listener único de cierre (click fuera / Escape). Se añade una sola vez.
function operantPopoverDocHandler(ev) {
  const pop = operantPopover;
  if (!pop) return;
  if (ev.type === "keydown") {
    if (ev.key === "Escape") {
      closeOperantPopover();
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
  if (operantPopoverAnchor && ev.target instanceof Node && operantPopoverAnchor.contains(ev.target)) return;
  if (typeof ev.clientX === "number") {
    if (overlayInPopover(ev.clientX, ev.clientY)) return;
    const ov = pageOverlay;
    if (ov && !ov.hidden && ov.isConnected) {
      const r = ov.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && inRect(ev.clientX, ev.clientY, r)) return;
    }
  }
  closeOperantPopover();
}
let operantPopoverAnchor = null;
document.addEventListener("pointerdown", operantPopoverDocHandler, true);
document.addEventListener("keydown", operantPopoverDocHandler, true);

function openOperantPopover(anchor, buildContent) {
  closeOperantPopover();
  operantPopoverAnchor = anchor;
  const pop = document.createElement("div");
  pop.id = "operant-popover";
  pop.className = "operant-popover";
  buildContent(pop);
  document.documentElement.appendChild(pop);
  operantPopover = pop;
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
  openOperantPopover(sourceEl, (pop) => {
    const title = document.createElement("div");
    title.className = "operant-pop-title";
    title.textContent = "Buscar imagen similar";
    pop.appendChild(title);
    const list = document.createElement("div");
    list.className = "operant-pop-list";
    for (const eng of SEARCH_ENGINES) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "operant-pop-item";
      item.textContent = eng.name;
      item.addEventListener("click", () => {
        closeOperantPopover();
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
      // (imagen sin CORS del sitio), toBlob falla y se recurre al SW.
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
    // Fallback FUNCIONAL para CDNs que contaminan el canvas (sin CORS):
    // los bytes llegan por el SW (fetch sin CORS + Referer real) como blob
    // local, que sí puede pintarse y copiarse.
    const url = imgEl instanceof HTMLImageElement ? imgEl.currentSrc || imgEl.src || "" : "";
    if (!/^https?:/.test(url)) throw new Error(`No se pudo copiar: ${e.message}`);
    const localBlob = await fetchBlobViaSw(url);
    const localUrl = URL.createObjectURL(localBlob);
    try {
      const img = new Image();
      img.src = localUrl;
      await img.decode().catch(() => { throw new Error("La imagen no se pudo decodificar"); });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const png = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("No se pudo generar el PNG"))), "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    } finally {
      setTimeout(() => URL.revokeObjectURL(localUrl), 30000);
    }
  }
}

// Caso B: contenido sin URL pública (frame capturado / blob / data:).
// Muestra un aviso transparente de subida temporal; si el usuario prefiere
// no subir, ofrece copiar al portapapeles para pegar manualmente.
function confirmUploadThenSearch(sourceEl, anchor, what) {
  openOperantPopover(anchor, (pop) => {
    const title = document.createElement("div");
    title.className = "operant-pop-title";
    title.textContent = `Buscar ${what} similar`;
    pop.appendChild(title);
    const note = document.createElement("div");
    note.className = "operant-pop-note";
    note.textContent = `Para buscar este ${what}, se subirá temporalmente a un servicio de alojamiento de imágenes anónimo (Litterbox, expira en 1h). ¿Continuar?`;
    pop.appendChild(note);
    const row = document.createElement("div");
    row.className = "operant-pop-row";
    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "operant-pop-item operant-pop-primary";
    uploadBtn.textContent = "Subir y buscar";
    uploadBtn.addEventListener("click", async () => {
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Subiendo…";
      try {
        const blob = await captureElementToPng(sourceEl);
        const hosted = await uploadToTmpHost(blob);
        closeOperantPopover();
        searchMenuFor(hosted, anchor);
      } catch (e) {
        uploadBtn.disabled = false;
        uploadBtn.textContent = "Subir y buscar";
        toastMsg(e.message || "No se pudo subir");
      }
    });
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "operant-pop-item";
    copyBtn.textContent = "Copiar al portapapeles";
    copyBtn.addEventListener("click", async () => {
      try {
        const blob = await captureElementToPng(sourceEl);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        closeOperantPopover();
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
let operantToastTimer = null;
function toastMsg(msg) {
  let el = document.getElementById("operant-overlay-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "operant-overlay-toast";
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(operantToastTimer);
  operantToastTimer = setTimeout(() => el.classList.remove("show"), 1800);
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
    let m3u8 = null;
    let mpd = null;
    let fallback = null;
    for (const it of store.values()) {
      if (it.source === "network" && it.type === "video" && it.url.startsWith("http")) {
        // Preferir M3U8 (HLS muxed: se descarga íntegro en el navegador);
        // el MPD de X trae audio separado y exige remux con el companion.
        if (/\.m3u8(?:[?#].*)?$/i.test(it.url)) {
          m3u8 = m3u8 || it.url;
          continue;
        }
        if (/\.mpd(?:[?#].*)?$/i.test(it.url)) {
          mpd = mpd || it.url;
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
    // Orden de preferencia: directo REAL (no-init) → m3u8 → mpd.
    if (url.startsWith("blob:") && fallback) url = fallback;
    if (url.startsWith("blob:") && (m3u8 || mpd)) url = m3u8 || mpd;
  }
  // URL no resoluble: el vídeo blob: no tiene stream de red capturado aún
  // (no se ha reproducido). El botón debe avisar, no mandar el blob: al SW.
  const blobUnresolved = url.startsWith("blob:");
  const isGif = type === "image" && /\.gif($|[?#])/i.test(url);
  // Los GIF de X/Twitter se sirven como MP4 MUDO (ruta tweet_video): no hay
  // audio que extraer. La verificación definitiva la hace el SW leyendo las
  // cajas MP4 al hacer click (cubriría cualquier otro vídeo mudo).
  const xGifNoAudio = type === "video" && /video\.twimg\.com\/tweet_video\//i.test(url);

  // Ejecuta una acción SW y traduce su respuesta real a resultado:
  // { ok, note? } | { ok: false, error }. NADA de éxito falso. ctxSend
  // traduce el contexto muerto a un mensaje humano.
  const swAction = (payload) =>
    ctxSend(payload)
      .catch((e) => ({ ok: false, error: String(e?.message || e) }))
      .then((r) => {
        if (!r?.ok) throw new Error(r?.error || "No se pudo completar la acción.");
        return r;
      });

  if (type === "image") {
    btns.push({
      icon: overlayIcon("image"),
      label: "Descargar imagen",
      action: () =>
        swAction({ type: "overlay-download", url: overlayBestUrl(url), filename: (el instanceof HTMLImageElement && el.alt) || "" }),
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
        label: "Descargar como vídeo (ffmpeg local)",
        action: () =>
          swAction({ type: "overlay-download-gif-video", url, filename: (el instanceof HTMLImageElement && el.alt) || "" }),
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
      action: async () => {
        if (blobUnresolved) {
          // Sin URL de red: pedir al SW que re-consulte (el stream pudo
          // cargarse entre el hover y el click) antes de rendirse.
          return swAction({ type: "overlay-download", url: "", filename: "", kind: "video", blobOnly: true });
        }
        if (!url) throw new Error("El elemento no expone una URL descargable.");
        // Ruta verificada: SW con Referer → cadena honesta del SW.
        return overlayDownloadInPage(url, "");
      },
    });
    if (!xGifNoAudio) {
      btns.push({
        icon: overlayIcon("audioOnly"),
        label: "Descargar solo el audio",
        action: () => swAction({ type: "overlay-download-audio", url, filename: "" }),
      });
    }
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
      action: () => swAction({ type: "overlay-download", url, filename: "" }),
    });
  } else if (type === "file") {
    btns.push({
      icon: overlayIcon("file"),
      label: "Descargar archivo",
      action: () => swAction({ type: "overlay-download", url, filename: "" }),
    });
  }
  return btns;
}

// Espera a que el <video> tenga un fotograma REAL decodificado. Con
// requestVideoFrameCallback (Chrome) la captura es determinista: el callback
// solo se dispara cuando un frame llega al compositor (evita frames negros).
// Fallback: loadeddata + sondeo de readyState. Devuelve true/false.
function waitForVideoFrame(el, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (el.readyState >= 2 && el.videoWidth > 0) return resolve(true);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(!!v);
    };
    const t = setTimeout(() => finish(el.readyState >= 2 && el.videoWidth > 0), timeoutMs);
    try {
      if (typeof el.requestVideoFrameCallback === "function") el.requestVideoFrameCallback(() => finish(true));
    } catch { /* sin rVFC: fallback por eventos */ }
    el.addEventListener("loadeddata", () => {
      try {
        if (typeof el.requestVideoFrameCallback === "function") el.requestVideoFrameCallback(() => finish(true));
        else finish(true);
      } catch { finish(true); }
    }, { once: true });
    el.addEventListener("error", () => finish(false), { once: true });
  });
}

// Descarga un blob vía el SW como data URL (fetch sin CORS + Referer real).
// Es el ÚNICO camino para capturar fotogramas/copiar en CDNs cross-origin:
// su canvas queda contaminado (tainted) y toBlob/getImageData fallan.
async function fetchBlobViaSw(url) {
  const r = await ctxSend({ type: "fetch-blob-data", url, pageUrl: location.href }).catch(() => null);
  if (!r?.ok) throw new Error(r?.error || "No se pudo capturar el medio (fallo de red o tamaño).");
  const res = await fetch(r.dataUrl);
  return res.blob();
}

// Captura el frame actual de un <video>/<img> y lo descarga vía el SW
// (overlay-download-blob con data URL → estado final verificado).
// Devuelve { ok, note } o { ok: false, error } — el llamador refleja el
// resultado REAL, sin check de éxito falso.
async function overlayCaptureFrame(el, mime) {
  const tryDraw = async (source, w, h) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D no disponible");
    ctx.drawImage(source, 0, 0, w, h);
    return await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("taint"))), mime, 0.92)
    );
  };

  let blob = null;
  let w = el.videoWidth || el.naturalWidth || el.width;
  let h = el.videoHeight || el.naturalHeight || el.height;
  if (!w || !h) throw new Error("El medio aún no ha decodificado ningún fotograma. Reprodúcelo e inténtalo de nuevo.");

  // 1) Captura directa del elemento (funciona con MSE/blob: y medios
  //    same-origin o con CORS). Los <video> esperan un frame decodificado.
  try {
    if (el instanceof HTMLVideoElement) {
      const ready = await waitForVideoFrame(el);
      if (!ready) throw new Error("taint");
      w = el.videoWidth || w;
      h = el.videoHeight || h;
    }
    blob = await tryDraw(el, w, h);
  } catch {
    // 2) Fallback funcional: bytes vía SW → blob local (mismo origen) →
    //    decode → canvas limpio. Funciona con cualquier CDN ≤64MB.
    const url = overlayUrlOf(el);
    if (!/^https?:/.test(url || "")) {
      throw new Error("El servidor del medio bloquea la captura (CORS) y el elemento no expone una URL de red.");
    }
    const localBlob = await fetchBlobViaSw(url);
    const localUrl = URL.createObjectURL(localBlob);
    try {
      if (el instanceof HTMLVideoElement) {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        v.src = localUrl;
        const ok = await waitForVideoFrame(v, 10000);
        w = v.videoWidth;
        h = v.videoHeight;
        if (!ok || !w || !h) throw new Error("El vídeo descargado no se pudo decodificar para extraer el fotograma.");
        blob = await tryDraw(v, w, h);
      } else {
        const img = new Image();
        img.src = localUrl;
        await img.decode().catch(() => { throw new Error("La imagen descargada no se pudo decodificar."); });
        w = img.naturalWidth;
        h = img.naturalHeight;
        if (!w || !h) throw new Error("La imagen no expone dimensiones.");
        blob = await tryDraw(img, w, h);
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(localUrl), 30000);
    }
  }

  if (!blob || blob.size < 64) throw new Error("El fotograma capturado está vacío.");
  // Entrega POR EL SW (data URL + monitor de finalización): el blob del
  // content script no es accesible desde chrome.downloads.
  const b64 = await blobToBase64(blob);
  const ext = mime === "image/png" ? "png" : "jpg";
  const r = await ctxSend({
    type: "overlay-download-blob", dataUrl: `data:${mime};base64,${b64}`, mime, filename: `frame-${Date.now()}.${ext}`,
  }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (!r?.ok) throw new Error(r?.error || "No se pudo guardar el fotograma.");
  return { ok: true, note: "Fotograma guardado." };
}

// Captura REAL desde el contexto de la página.
//
// Esto es lo que la documentación siempre prometió ("capturar el recurso DESDE
// la página, con cookies + Referer de sesión") y lo que no existía: la
// implementación anterior delegaba de vuelta en el service worker, que es
// justo donde las cookies HttpOnly NO están disponibles. El resultado era que
// el "Nivel B" no aportaba nada que el "Nivel A" no tuviera ya.
//
// Un fetch desde un content script:
//   · sale con el ORIGEN de la página, así que el navegador adjunta las
//     cookies del sitio — incluidas las HttpOnly, porque el navegador las
//     añade, no nosotros;
//   · envía `Referer` = la URL de la página, sin que nadie lo falsifique;
//   · está sujeto a CORS de la página: si el CDN no manda ACAO, morimos aquí
//     (y para eso está el Nivel A, que usa <all_urls> desde el SW).
//
// Por eso esta vía es un COMPLEMENTO del Nivel A, no un sustituto, y por eso
// tiene un tope: el transporte de vuelta es un data URL en un único mensaje,
// que a partir de cierto tamaño es una boga de memoria.
const IN_PAGE_CAPTURE_MAX = 16 * 1024 * 1024;

async function captureInPage(url, filename) {
  const res = await fetch(url, {
    credentials: "include",
    referrer: location.href,
    referrerPolicy: "unsafe-url",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > IN_PAGE_CAPTURE_MAX) {
    throw new Error(
      `El recurso mide ${(declared / 1048576).toFixed(0)} MB y la captura en página está limitada a ${(IN_PAGE_CAPTURE_MAX / 1048576).toFixed(0)} MB. Descárgalo desde el panel (cola por chunks).`
    );
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error("La página recibió una respuesta vacía");
  if (blob.size > IN_PAGE_CAPTURE_MAX) {
    throw new Error(
      `El recurso mide ${(blob.size / 1048576).toFixed(0)} MB y la captura en página está limitada a ${(IN_PAGE_CAPTURE_MAX / 1048576).toFixed(0)} MB. Descárgalo desde el panel.`
    );
  }
  const mime = blob.type || "application/octet-stream";
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el recurso"));
    reader.readAsDataURL(blob);
  });
  if (!dataUrl.startsWith("data:")) throw new Error("No se pudo preparar el recurso");
  // El SW entrega el data URL al gestor de descargas y espera su estado final.
  await ctxSend({ type: "overlay-download-blob", dataUrl, filename, mime });
  return { ok: true, note: "Capturado desde la página con la sesión del sitio." };
}

// Descarga desde el content script. Cadena de tres niveles, cada uno con una
// ventaja distinta sobre el anterior (no tres intentos de lo mismo):
//   1. sw-fetch-blob — el SW hace el fetch con <all_urls> (sin CORS) y Referer
//      inyectado por DNR. Es el más general: funciona con cualquier CDN. Si el
//      usuario concedió el permiso opcional `cookies`, el SW además inyecta la
//      cabecera Cookie, y entonces cubre también el contenido autenticado.
//   2. capture-in-page — fetch desde la página: cookies HttpOnly y Referer
//      reales, sin necesidad de ningún permiso. Limitado a 16 MB y a CDNs que
//      manden ACAO.
//   3. overlay-download — la cadena completa del SW (sondeo → descarga del
//      navegador monitorizada → Referer → yt-dlp), que además sabe resolver
//      blob: buscando el stream real entre los capturados por webRequest.
// Devuelve el resultado REAL del nivel que funcionó, para el indicador.
async function overlayDownloadInPage(url, filename) {
  const res = await ctxSend({
    type: "sw-fetch-blob",
    url,
    filename,
    pageUrl: location.href,
  }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (res?.ok) return { ok: true, note: res.note };

  const pageRes = await captureInPage(url, filename).catch((e) => ({
    ok: false,
    error: String(e?.message || e),
  }));
  if (pageRes?.ok) return pageRes;

  const r2 = await ctxSend({ type: "overlay-download", url, filename, kind: "video" })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  return r2 || { ok: false, error: `Sin respuesta del service worker (sw: ${res?.error || "?"}; página: ${pageRes?.error || "?"})` };
}

function showPageOverlay(el) {
  if (contextDead || !overlayAllowedFor(location)) return;
  if (!overlayTargetEligible(el)) return; // filtros configurables (tamaño/SVG)
  const btns = overlayButtonsFor(el);
  if (!btns.length) return;
  const ov = ensurePageOverlay();
  ov.textContent = "";
  ov.classList.remove("operant-ov-busy");
  // El botón de descarga (el primero, para vídeo) puede mostrar el indicador
  // de motion design compartido (anillo indeterminado → check) durante la
  // descarga, en vez del icono estático + giro genérico.
  for (let i = 0; i < btns.length; i++) {
    const b = btns[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "operant-ov-btn";
    btn.title = b.label; // tooltip NATIVO del navegador (sin duplicados custom)
    btn.setAttribute("aria-label", b.label);
    // Acción principal sugerida: el primer botón (descargar) con tratamiento
    // destacado consistente (fondo morado suave + texto blanco).
    if (i === 0) btn.classList.add("operant-ov-primary");
    let indicator = null;
    const DLInd = window.OperantDLIndicator || window.NTDLIndicator;
    if (i === 0 && DLInd && b.label.startsWith("Descargar")) {
      // Indicador dentro del botón: idle (flecha) → anillo → check.
      indicator = new DLInd(btn, { size: "sm" });
      btn.classList.add("operant-dl-host");
    } else {
      btn.innerHTML = b.icon;
    }
    btn.addEventListener("click", async (ev) => {
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
      if (ov.classList.contains("operant-ov-busy")) return;
      ov.classList.add("operant-ov-busy");
      if (indicator) {
        indicator.setProgress(undefined); // indeterminado: anillo rotando
      }
      // HONESTIDAD: se ESPERA el resultado real de la acción (el SW responde
      // tras verificar los bytes y el estado final de la descarga, o con un
      // error con su causa). El check SOLO aparece con éxito verificado.
      let outcome = { ok: true };
      try {
        outcome = (await b.action(btn)) || { ok: true };
      } catch (e) {
        outcome = { ok: false, error: String(e?.message || e) };
      }
      clearTimeout(overlayHideTimer);
      if (outcome.ok === false) {
        if (indicator) indicator.error();
        toastMsg(outcome.error || "No se pudo completar la acción");
        overlayHideTimer = setTimeout(() => {
          ov.classList.remove("operant-ov-busy");
          hidePageOverlay();
        }, 2400);
        return;
      }
      // "ENCOLADO" (companion/yt-dlp): el resultado REAL llegará al panel —
      // declararlo como éxito verificado sería mentir. Toast informativo,
      // SIN check.
      if (outcome.enqueued) {
        toastMsg(outcome.note || "Enviado al procesador local… El resultado se confirma en el panel.");
        overlayHideTimer = setTimeout(() => hidePageOverlay(), 1400);
        return;
      }
      // Éxito verificado (archivo entregado al gestor de descargas).
      if (indicator) {
        indicator.success();
        overlayHideTimer = setTimeout(() => hidePageOverlay(), 1200);
      } else {
        toastMsg(outcome.note || "Descarga completada.");
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
    closeOperantPopover();
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
const OPERANT_POPOVER_HOVER_MARGIN = 10;
function overlayInPopover(x, y) {
  const pop = operantPopover;
  if (!pop || !pop.isConnected) return false;
  const r = pop.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return inRect(x, y, rectExpanded(r, OPERANT_POPOVER_HOVER_MARGIN));
}

function handleOverlayMove(x, y) {
  if (contextDead || !overlayAllowedFor(location)) return;
  // Mientras el overlay esté "ocupado" (acción en curso tras un click),
  // no ocultarlo: el feedback de procesando debe completarse.
  if (pageOverlay && !pageOverlay.hidden && pageOverlay.classList.contains("operant-ov-busy")) return;
  const el = overlayAtPoint(x, y);
  if (!(el instanceof Element)) return;

  // Si el cursor está sobre el propio overlay, mantenerlo (y su popover).
  if (el.closest("#operant-page-overlay")) {
    positionPageOverlay();
    return;
  }
  // Si el cursor está sobre el popover, mantenerlo. El popover suele quedar
  // separado del botón por un margen: al mover el ratón del botón al menú,
  // el punto cae en el hueco. Si el hueco cae dentro del rect EXPANDIDO del
  // popover, seguimos considerándolo "sobre el popover" (hover tolerante).
  if (el.closest("#operant-popover") || overlayInPopover(x, y)) {
    return;
  }

  // El cursor salió del overlay y del popover: cerrar el popover
  // INMEDIATAMENTE (sin delay) — reactividad estricta al salir del hover.
  if (operantPopover) closeOperantPopover();

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
  if (hit.closest("#operant-page-overlay") || hit.closest("#operant-popover")) return true;
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

// Estilos del overlay (aislados con prefijo operant- para no chocar con la página).
// Diseño milimétrico: contenedor compacto, transparencia base, hover estable
// (sin scale que tambalee), animación de pulsación sobria y feedback de acción.
// Incluye el CSS del indicador de descarga compartido (anillo/check/error).
// REMOVE-then-CREATE: una nueva generación siempre impone SU css (la de una
// generación previa pudo quedar huérfana tras recargar la extensión).
{
  document.getElementById("operant-page-overlay-style")?.remove();
  const style = document.createElement("style");
  style.id = "operant-page-overlay-style";
  const indCss = window.OperantDLIndicatorCSS || window.NTDLIndicatorCSS;
  style.textContent = (indCss ? indCss() : "") + `
    /* Modo NATIVO: CSS Anchor Positioning (Chrome 125+).
       El overlay se posiciona relativo al ancla (imagen/vídeo bajo el cursor)
       con anchor() y position-anchor. El motor de renderizado mueve el
       overlay en el mismo hilo de composición que el scroll: sincronización
       perfecta, sin JS en el camino. El offset de 8-10px se aplica con margin
       para no chocar con el top/left del fallback JS (que no debe existir
       aquí). */
    #operant-page-overlay[data-anchored="1"] {
      position: fixed;
      position-anchor: var(--operant-anchor-none); /* se sobreescribe por JS con el nombre real */
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
    @supports not (anchor-name: --operant-test) {
      #operant-page-overlay {
        position: fixed;
        top: 8px;
        left: 8px;
        margin: 0;
      }
    }
    #operant-page-overlay {
      z-index: 2147483647;
      display: flex;
      flex-direction: row;
      gap: 3px;
      padding: 3px;
      background: rgba(18, 18, 20, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      opacity: 0.92;
      transition: opacity 0.14s ease, background 0.14s ease, box-shadow 0.14s ease;
    }
    #operant-page-overlay:hover {
      opacity: 1;
      background: rgba(18, 18, 20, 0.92);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    }
    #operant-page-overlay[hidden] { display: none; }
    #operant-page-overlay .operant-ov-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: rgba(240, 240, 242, 0.85);
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    #operant-page-overlay .operant-ov-btn:hover {
      background: rgba(224, 78, 57, 0.35);
      color: #fff;
    }
    #operant-page-overlay .operant-ov-btn:active {
      background: rgba(224, 78, 57, 0.55);
    }
    /* Acción principal sugerida (primer botón, descargar): tratamiento
       destacado consistente con el hover, para guiar al usuario. */
    #operant-page-overlay .operant-ov-btn.operant-ov-primary {
      background: rgba(224, 78, 57, 0.22);
      color: #fff;
    }
    #operant-page-overlay .operant-ov-btn svg {
      display: block;
      width: 13px;
      height: 13px;
    }
    /* Pulsación sobria al hacer click: micro-scale SIMÉTRICO y MONÓTONO
       (sin overshoot ni rebote — el overshoot tambalea el icono). El
       transform-origin centrado evita desplazamiento subpixel. */
    #operant-page-overlay .operant-ov-btn svg {
      transform-origin: center center;
    }
    #operant-page-overlay .operant-ov-btn:active svg {
      animation: operant-ov-press 0.18s cubic-bezier(0.25, 0.1, 0.25, 1);
    }
    @keyframes operant-ov-press {
      0% { transform: scale(1); }
      45% { transform: scale(0.85); }
      100% { transform: scale(1); }
    }
    /* Mientras el overlay está ocupado (descarga en curso), los botones no
       responden a clicks duplicados — SIN rotar los iconos. El anillo de
       progreso del indicador (dl-indicator.js) es lo único que anima. */
    #operant-page-overlay.operant-ov-busy .operant-ov-btn {
      pointer-events: none;
    }
    /* Popover inteligente (búsqueda inversa / confirmación de subida).
       En modo nativo se posiciona relativo al OVERLAY DE ICONOS (--operant-ov-anchor),
       NO a la imagen: queda justo debajo de los botones, como el fallback JS.
       Reposiciona automáticamente cerca de bordes con position-try-fallbacks. */
    #operant-popover[data-anchored="1"] {
      position: fixed;
      position-anchor: --operant-ov-anchor;
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
    @supports not (anchor-name: --operant-test) {
      #operant-popover {
        position: fixed;
        margin: 0;
      }
    }
    #operant-popover {
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
      animation: operant-pop-in 0.12s ease-out;
    }
    @keyframes operant-pop-in {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    #operant-popover .operant-pop-title {
      font-weight: 600;
      color: #cbd5e1;
      padding: 4px 6px 6px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.15);
      margin-bottom: 4px;
    }
    #operant-popover .operant-pop-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    #operant-popover .operant-pop-item {
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
    #operant-popover .operant-pop-item:hover {
      background: rgba(224, 78, 57, 0.3);
      color: #fff;
    }
    #operant-popover .operant-pop-item:disabled {
      opacity: 0.6;
      cursor: default;
    }
    #operant-popover .operant-pop-primary {
      background: rgba(224, 78, 57, 0.35);
      color: #fff;
      font-weight: 600;
    }
    #operant-popover .operant-pop-primary:hover {
      background: rgba(224, 78, 57, 0.5);
    }
    #operant-popover .operant-pop-note {
      padding: 4px 6px 8px;
      color: #94a3b8;
      line-height: 1.45;
    }
    #operant-popover .operant-pop-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    /* Toast del overlay (feedback de copiar / errores). */
    #operant-overlay-toast {
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
    #operant-overlay-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(-4px);
    }
  `;
  document.documentElement.appendChild(style);
}
