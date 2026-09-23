// panel.js — Lógica del side panel de Operant.
// Lee el estado del service worker, filtra, renderiza con lazy-rendering,
// gestiona descargas individuales / en zip / con yt-dlp, y ofrece previews
// reales (lightbox con zoom, reproductor de vídeo con HLS, audio).
//
// Correcciones de la v0.4:
//   - El estado vacío y los skeletons son mutuamente excluyentes: el vacío
//     solo se muestra cuando hay items y el filtrado real da 0.
//   - `requestState()` no puede dejar `loading` colgado (try/catch + timeout),
//     y un `state-updated` en vivo desbloquea los skeletons.
//   - "Ocultar <10 KB" está DESACTIVADO por defecto (causaba "Nada coincide
//     con los filtros" con contador lleno en páginas con iconos pequeños).

// ÚNICA FUENTE DE VERDAD de detección/descarga (compartida con el SW).
import { OperantMedia } from "../shared/media-core.js";
// Ruta rápida HLS 100% en navegador (sin host nativo): parseo + fetch paralelo
// + AES-128 (WebCrypto) + concat binaria fMP4/TS. Mismo motor que el SW.
import { HLSFast } from "../shared/hls-fast.js";

// CSS del indicador de descarga (componente compartido con el overlay).
const dlCss = window.OperantDLIndicatorCSS || window.NTDLIndicatorCSS;
if (dlCss && !document.getElementById("operant-dl-style")) {
  const st = document.createElement("style");
  st.id = "operant-dl-style";
  st.textContent = dlCss();
  document.head.appendChild(st);
}

const grid = document.getElementById("grid");
const sentinel = document.getElementById("sentinel");
const empty = document.getElementById("empty");
const emptyTitle = document.getElementById("emptyTitle");
const emptyHint = document.getElementById("emptyHint");
const btnEmptyReset = document.getElementById("btnEmptyReset");
const statusText = document.getElementById("statusText");
const statusBar = document.getElementById("statusBar");
if (statusText && statusBar) {
  const syncStatusVisibility = () => {
    const txt = (statusText.textContent || "").trim();
    statusBar.hidden = !txt;
  };
  syncStatusVisibility();
  try {
    new MutationObserver(syncStatusVisibility).observe(statusText, { childList: true, characterData: true, subtree: true });
  } catch {}
}
const connDot = document.getElementById("connDot");
const nativeChip = document.getElementById("nativeChip");
const btnAuto = document.getElementById("btnAuto");
const btnRecord = document.getElementById("btnRecord");
const btnRefresh = document.getElementById("btnRefresh");
const btnFilter = document.getElementById("btnFilter");
const filterPop = document.getElementById("filterPop");
const btnClearFilters = document.getElementById("btnClearFilters");
const btnZip = document.getElementById("btnZip");
const btnProcess = document.getElementById("btnProcess");
const btnDl = document.getElementById("btnDl");
const btnYtdl = document.getElementById("btnYtdl");
const btnClearSel = document.getElementById("btnClearSel");
const chkSelectAll = document.getElementById("chkSelectAll");
const selInfo = document.getElementById("selInfo");
const procDialog = document.getElementById("procDialog");
const procSource = document.getElementById("procSource");
const procOp = document.getElementById("procOp");
const procQualityField = document.getElementById("procQualityField");
const procQuality = document.getElementById("procQuality");
const procBar = document.getElementById("procBar");
const procStatus = document.getElementById("procStatus");
const procRun = document.getElementById("procRun");
const dlDialog = document.getElementById("dlDialog");
const dlJobsEl = document.getElementById("dlJobs");
const dlTotalBar = document.getElementById("dlTotalBar");
const dlTotalText = document.getElementById("dlTotalText");
const dlConcurrency = document.getElementById("dlConcurrency");
const sortBy = document.getElementById("sortBy");
const thumbSize = document.getElementById("thumbSize");
const thumbVal = document.getElementById("thumbVal");
const dlMode = document.getElementById("dlMode");
const chkHideSmall = document.getElementById("chkHideSmall");
const chkDupes = document.getElementById("chkDupes");
const chkOverlay = document.getElementById("chkOverlay");
const btnExport = document.getElementById("btnExport");
const btnHistory = document.getElementById("btnHistory");
const historyDialog = document.getElementById("historyDialog");
const historySearch = document.getElementById("historySearch");
const historyList = document.getElementById("historyList");
const btnHistoryExport = document.getElementById("btnHistoryExport");
const search = document.getElementById("search");
const fMinSize = document.getElementById("fMinSize");
const fExt = document.getElementById("fExt");
const fDomain = document.getElementById("fDomain");
const domainList = document.getElementById("domainList");
const layoutSel = document.getElementById("layoutSel");
const counterText = document.getElementById("counterText");
const scanBar = document.getElementById("scanBar");
const scanFill = document.getElementById("scanFill");
const scanText = document.getElementById("scanText");
const btnStopScan = document.getElementById("btnStopScan");
const lightboxDialog = document.getElementById("lightboxDialog");
const lbTitle = document.getElementById("lbTitle");
const lbMeta = document.getElementById("lbMeta");
const lbStage = document.getElementById("lbStage");
const lbImg = document.getElementById("lbImg");
const lbErr = document.getElementById("lbErr");
const lbPrev = document.getElementById("lbPrev");
const lbNext = document.getElementById("lbNext");
const lbZoomIn = document.getElementById("lbZoomIn");
const lbZoomOut = document.getElementById("lbZoomOut");
const lbZoomVal = document.getElementById("lbZoomVal");
const lbReset = document.getElementById("lbReset");
const lbDownload = document.getElementById("lbDownload");
const lbOpen = document.getElementById("lbOpen");
const lbClose = document.getElementById("lbClose");
const videoDialog = document.getElementById("videoDialog");
const vdTitle = document.getElementById("vdTitle");
const vdMeta = document.getElementById("vdMeta");
const vdEl = document.getElementById("vdEl");
const vdErr = document.getElementById("vdErr");
const vdDownload = document.getElementById("vdDownload");
const vdOpen = document.getElementById("vdOpen");
const vdClose = document.getElementById("vdClose");
const audioDialog = document.getElementById("audioDialog");
const adTitle = document.getElementById("adTitle");
const adMeta = document.getElementById("adMeta");
const adEl = document.getElementById("adEl");
const adErr = document.getElementById("adErr");
const adDownload = document.getElementById("adDownload");
const adOpen = document.getElementById("adOpen");
const adClose = document.getElementById("adClose");

const RENDER_CHUNK = 60;
const TABS = ["image", "video", "audio", "file"];
const TAB_LABELS = { image: "Imágenes", video: "Vídeos", audio: "Audio", file: "Archivos" };

const state = {
  tabId: null,
  items: [],
  tab: "image", // image | video | audio | file
  selected: new Set(), // urls seleccionadas
  rendered: 0,
  masonryCols: null, // columnas flex activas en vista masonry
  activeSentinel: null, // sentinel observado para el lazy-render
  selHydrated: false,
  native: { installed: false, checkedAt: 0, tools: null },
};

const viewPrefs = {
  view: "full", // full = ancho completo (POR DEFECTO, estilo ImageEye) | masonry
  sort: "smart", // POR DEFECTO: imágenes grandes/pesadas según orden de aparición en la web
  thumb: 120,
  hideSmall: false,
  dupes: true,
  tab: "image",
  fMinSize: "0",
  fExt: "",
  fDomain: "",
  // Interacción de descarga en las cards: "click" (hover revela, click ejecuta,
  // por defecto — patrón estándar) | "hold" (hover sostenido ~700ms dispara).
  hoverDl: "click",
};

const COUNTER_LABELS = {
  image: { s: "imagen", p: "imágenes", v: "a" },
  video: { s: "vídeo", p: "vídeos", v: "o" },
  audio: { s: "audio", p: "audios", v: "o" },
  file: { s: "archivo", p: "archivos", v: "o" },
};

let lastFiltered = [];
let lastClickIndex = -1;
let loading = true;
let dupMap = new Map();

// --- Utilidades ---
function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error("timeout")), ms);
    }),
  ]);
}

function toolInfo(toolName) {
  const tools = state.native?.tools;
  if (!tools) {
    const isYt = toolName === "yt-dlp" || toolName === "ytDlp";
    const installed = isYt ? !!state.native?.ytDlp : !!state.native?.ffmpeg;
    return { installed, unknown: true };
  }
  const t = tools[toolName] ?? (toolName === "yt-dlp" ? tools["ytDlp"] : toolName === "ytDlp" ? tools["yt-dlp"] : undefined);
  if (t === undefined) return { installed: false, unknown: false };
  if (typeof t === "boolean") return { installed: t, legacy: true };
  return t;
}

function formatSize(kb, sizeUnknown = false) {
  if (kb === null || kb === undefined) return sizeUnknown ? "?" : "…";
  if (sizeUnknown) return "?"; // no se pudo obtener el tamaño real
  if (kb === 0) return "<1 KB";
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function itemName(item) {
  if (item.name) return item.name;
  if (item.title) return item.title;
  if (item.url && item.url.startsWith("data:")) {
    const ext = item.ext || "jpg";
    return `image_${(item.w && item.h) ? `${item.w}x${item.h}_` : ""}${Math.abs(item.url.length)}.${ext}`;
  }
  try {
    const u = new URL(item.url);
    let last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    if (last && item.ext && !last.toLowerCase().endsWith(`.${item.ext}`)) {
      if (!/\.[a-z0-9]{2,5}$/i.test(last)) {
        last = `${last}.${item.ext}`;
      }
    }
    return last || u.hostname;
  } catch {
    return item.url;
  }
}

function metaString(item) {
  const bits = [];
  bits.push(formatSize(item.sizeKB, item.sizeUnknown));
  if (item.w && item.h) bits.push(`${item.w}×${item.h}`);
  if (item.durationSec) bits.push(formatDuration(item.durationSec));
  bits.push(item.domain);
  return bits.filter(Boolean).join(" · ");
}

// --- Contadores por tipo (totales de la pestaña, sin filtros) ---
function counts() {
  const c = { image: 0, video: 0, audio: 0, file: 0 };
  for (const it of state.items) {
    if (c[it.type] !== undefined) c[it.type]++;
  }
  return c;
}

function isSmallMedia(it) {
  if (it.type !== "image") return false;
  // Dimensiones conocidas pequeñas (< 100px y área < 12000 px²)
  if (it.w > 0 && it.h > 0 && (it.w < 100 || it.h < 100) && (it.w * it.h < 12000)) {
    return true;
  }
  // Peso conocido minúsculo (< 3 KB) sin dimensiones grandes
  if (it.sizeKB !== null && it.sizeKB < 3 && (!it.w || it.w < 100) && (!it.h || it.h < 100)) {
    return true;
  }
  return false;
}

// --- Filtrado + ordenación ---
function sortedItems() {
  const q = search.value.trim().toLowerCase();
  const minKb = Number(fMinSize.value || 0) || 0;
  const ext = fExt.value;
  const domain = fDomain.value.trim().toLowerCase();

  const list = state.items.filter((it) => {
    if (it.type !== state.tab) return false;
    // Init segments de fMP4 (X/Instagram): metadata sin vídeo — no son
    // descargables y no deben mostrarse como medios.
    if (it.method === "init") return false;
    // Tamaño desconocido (?): NUNCA se excluye por filtros de tamaño. Un item
    // sin tamaño no es "0 KB", es "no aplicable" — el usuario debe verlo con
    // su badge "?" y decidir, no desaparece silenciosamente.
    const sizeKnown = it.sizeKB !== null && it.sizeKB !== undefined;
    if (sizeKnown && minKb > 0 && it.sizeKB < minKb) return false;
    if (sizeKnown && viewPrefs.hideSmall && it.sizeKB > 0 && it.sizeKB < 10) return false;
    if (ext && it.ext !== ext) return false;
    if (domain && !it.domain.includes(domain)) return false;
    if (q && !itemName(it).toLowerCase().includes(q) && !it.url.toLowerCase().includes(q)) return false;
    return true;
  });

  const s = viewPrefs.sort || "smart";
  if (s === "smart") {
    // Orden de la web: imágenes grandes/pesadas primero en su orden de aparición visual,
    // y los iconos / elementos decorativos pequeños abajo (también en orden).
    list.sort((a, b) => {
      const aSmall = isSmallMedia(a) ? 1 : 0;
      const bSmall = isSmallMedia(b) ? 1 : 0;
      if (aSmall !== bSmall) return aSmall - bSmall;
      return (a._idx ?? 0) - (b._idx ?? 0);
    });
  } else if (s === "size") {
    list.sort((a, b) => {
      const sizeA = a.sizeKB ?? -1;
      const sizeB = b.sizeKB ?? -1;
      if (sizeA !== sizeB && sizeA >= 0 && sizeB >= 0) {
        return sizeB - sizeA;
      }
      if (sizeA >= 0 && sizeB < 0) return -1;
      if (sizeB >= 0 && sizeA < 0) return 1;
      // Desempate por dimensiones (mayor área en píxeles w*h arriba)
      const dimsA = (a.w && a.h) ? a.w * a.h : -1;
      const dimsB = (b.w && b.h) ? b.w * b.h : -1;
      if (dimsA !== dimsB) return dimsB - dimsA;
      return (a._idx ?? 0) - (b._idx ?? 0);
    });
  } else if (s === "dims") {
    const d = (it) => (it.w && it.h ? it.w * it.h : -1);
    list.sort((a, b) => {
      const dimsA = d(a);
      const dimsB = d(b);
      if (dimsA !== dimsB) return dimsB - dimsA;
      return (b.sizeKB ?? -1) - (a.sizeKB ?? -1);
    });
  } else if (s === "detect") {
    list.sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  } else if (s === "domain") {
    list.sort((a, b) => (a.domain || "").localeCompare(b.domain || ""));
  }
  return list;
}

function hasActiveFilters() {
  return Boolean(
    search.value.trim() ||
      fDomain.value.trim() ||
      fExt.value !== "" ||
      (Number(fMinSize.value || 0) || 0) > 0 ||
      viewPrefs.hideSmall
  );
}

// --- Posibles duplicados (mismo recurso, distinto CDN/host) ---
function dupKeysOf(items) {
  const seen = new Map();
  const out = new Map();
  for (const it of items) {
    if (it.type !== "image") continue;
    try {
      const u = new URL(it.url);
      const key = `${u.pathname}${u.search}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) out.set(it.url, true);
    } catch {
      /* URL invalida */
    }
  }
  return out;
}

// --- Estado de items (única vía de entrada, evita arrays rotos) ---
function setItems(items) {
  state.items = (Array.isArray(items) ? items : []).map((it, idx) => {
    if (it._idx === undefined) it._idx = idx;
    return it;
  });
  const valid = new Set(state.items.map((it) => it.url));
  for (const u of [...state.selected]) {
    if (!valid.has(u)) state.selected.delete(u);
  }
  populateExtOptions();
}

// Etiqueta del método de detección para la transparencia de la jerarquía
// de vídeo (Parte B): directo / stream (sniffing) / manifest / embed / yt-dlp.
function methodLabel(item) {
  const m = item.method || (item.embed ? "embed" : item.source === "network" ? "network" : "dom");
  switch (m) {
    case "dom": return "directo";
    case "network": return "stream";
    case "manifest": return "manifest";
    case "embed": return "embed";
    default: return m;
  }
}

function methodBadge(item) {
  const b = document.createElement("span");
  const m = item.method || (item.embed ? "embed" : item.source === "network" ? "network" : "dom");
  b.className = "badge method method-" + (m === "manifest" ? "manifest" : m);
  b.textContent = methodLabel(item);
  b.title = m === "dom" ? "URL directa en el DOM"
    : m === "network" ? "Detectado por sniffing de red (webRequest)"
    : m === "manifest" ? "Manifiesto HLS/DASH — parseable sin yt-dlp"
    : m === "embed" ? "Embed de plataforma — requiere yt-dlp"
    : "Origen desconocido";
  return b;
}

// Badge de numeración de tarjeta (índice 1-based, para ordenar los archivos).
// Se coloca en una esquina libre de cada card según la vista.
function cardNumberBadge(n) {
  const b = document.createElement("span");
  b.className = "card-number";
  b.textContent = String(n + 1);
  b.title = `Tarjeta nº ${n + 1} — orden de detección`;
  return b;
}

// --- Acciones rápidas por tipo de contenido ---

// Intenta obtener la URL de MAYOR resolución real para una imagen: si la URL
// tiene parámetros de resize de CDN (w=, width=, resize=, s=...), los quita
// para pedir la original. En srcset el item con más píxeles ya existe como
// candidato separado en state.items (cada variante es un item distinto).
const RESIZE_PARAM_RE = /(?:[?&](?:w|width|h|height|resize|s|size|maxwidth|maxheight)=[^&]*)/gi;

function bestImageUrl(item) {
  let url = item.url;
  if (item.type === "image") {
    try {
      const u = new URL(url);
      u.search = u.search.replace(RESIZE_PARAM_RE, "");
      if (u.search !== new URL(item.url).search) url = u.href;
    } catch {
      /* URL no parseable: se usa tal cual */
    }
  }
  return url;
}

// Captura el frame actual de un <video> o <img> (GIF animado) a PNG/JPEG
// usando un <canvas> oculto. Devuelve la URL del blob para descargar.
function captureFrame(srcEl, mime = "image/png") {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement("canvas");
      const w = srcEl.videoWidth || srcEl.naturalWidth || srcEl.width;
      const h = srcEl.videoHeight || srcEl.naturalHeight || srcEl.height;
      if (!w || !h) return reject(new Error("Sin dimensiones de frame"));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas 2D no disponible"));
      // Para vídeo: dibujar el frame actual. Para GIF: el frame visible.
      ctx.drawImage(srcEl, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("toBlob falló"));
        resolve(blob);
      }, mime, 0.92);
    } catch (e) {
      reject(e);
    }
  });
}

// Descarga el frame capturado (blob -> chrome.downloads).
async function downloadFrame(blob, filename) {
  const objUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url: objUrl, filename, conflictAction: "uniquify" });
    statusText.textContent = `Frame guardado: ${filename}`;
  } catch {
    statusText.textContent = "No se pudo guardar el frame.";
  }
  setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
}

// Toast/feedback breve de confirmación (coherente con el diseño sobrio).
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById("operantToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "operantToast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

// --- Botón de acción rápida con soporte de hover sostenido ---
// Modo "click" (por defecto): hover revela, click ejecuta.
// Modo "hold": hover sostenido ~700ms sobre el botón dispara, con un anillo
// de progreso que permite al usuario retirar el ratón antes de completarse.
const HOLD_MS = 700;

function quickBtn(glyph, label, opts = {}) {
  const b = document.createElement("button");
  b.className = "icon-btn quick-btn";
  if (opts.cls) b.classList.add(opts.cls);
  b.title = label;
  b.setAttribute("aria-label", label);
  // Los botones de descarga (act-dl) usan el indicador de motion design
  // compartido (anillo de progreso real/indeterminado, check, error) en vez
  // del glyph de texto. El resto sigue con texto.
  let indicator = null;
  const DLInd = window.OperantDLIndicator || window.NTDLIndicator;
  if (opts.cls === "act-dl" && DLInd) {
    indicator = new DLInd(b);
    b.classList.add("operant-dl-host");
  } else {
    b.textContent = glyph;
  }
  const onActivate = opts.onActivate || (() => {});
  // Reporte de progreso: el llamador puede pasar onStart/onDone/onError
  // (promesas) para manejar los estados del indicador.
  const reportStart = opts.onStart;
  const reportDone = opts.onDone;
  const reportError = opts.onError;

  const activate = () => {
    if (indicator && indicator.state !== "idle") return; // no re-disparar en curso
    if (indicator && reportStart) indicator.setProgress(reportStart());
    try {
      const r = onActivate(indicator);
      if (indicator && r && typeof r.then === "function") {
        r.then(
          () => { if (indicator) { if (reportDone) reportDone(); else indicator.success(); } },
          (e) => { if (indicator) { if (reportError) reportError(e); else indicator.error(); } }
        );
      } else if (indicator && !reportStart) {
        // Sin promesa ni progreso: indeterminado breve y vuelta a idle.
        indicator.setProgress(undefined);
        setTimeout(() => indicator.success(), 600);
      }
    } catch (e) {
      if (indicator) { if (reportError) reportError(e); else indicator.error(); }
    }
  };

  if (viewPrefs.hoverDl === "hold" && opts.holdable) {
    let holdTimer = null;
    let cancelled = false;
    const ring = document.createElement("span");
    ring.className = "hold-ring";
    b.appendChild(ring);
    b.addEventListener("mouseenter", () => {
      cancelled = false;
      ring.style.animation = "none";
      // reflow para reiniciar la animación
      void ring.offsetWidth;
      ring.style.animation = `hold-fill ${HOLD_MS}ms linear forwards`;
      holdTimer = setTimeout(() => {
        if (!cancelled) activate();
      }, HOLD_MS);
    });
    b.addEventListener("mouseleave", () => {
      cancelled = true;
      clearTimeout(holdTimer);
      ring.style.animation = "none";
    });
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!cancelled) activate();
    });
  } else {
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      activate();
    });
  }
  return b;
}

// Construye el conjunto de botones de acción según el tipo de contenido.
// Devuelve un array de botones listos para insertar.
function typeActionButtons(item, index, card) {
  const btns = [];
  const isGif = item.type === "image" && /\.gif($|[?#])/i.test(item.url);

  if (item.type === "image") {
    // Imagen: "alta calidad" (y captura de frame si es GIF animado).
    btns.push(
      quickBtn("⬇", "Descargar en alta calidad", {
        cls: "act-dl",
        holdable: true,
        onActivate: (ind) => {
          const best = bestImageUrl(item);
          if (best !== item.url) toast("Usando la mayor resolución");
          const dlItem = best !== item.url ? { ...item, url: best } : item;
          downloadOne(dlItem, ind);
        },
      })
    );
    if (isGif) {
      btns.push(
        quickBtn("◉", "Descargar frame actual del GIF", {
          cls: "act-frame",
          holdable: true,
          onActivate: async () => {
            const img = card ? card.querySelector(`img[src="${CSS.escape(item.url)}"]`) : null;
            if (!img) { statusText.textContent = "Frame no disponible (imagen no renderizada)."; return; }
            try {
              const blob = await captureFrame(img, "image/png");
              await downloadFrame(blob, `${itemName(item).replace(/\.[^.]+$/, "")}-frame.png`);
              toast("Frame guardado");
            } catch (e) {
              statusText.textContent = `No se pudo capturar el frame: ${e.message}`;
            }
          },
        })
      );
    }
  } else if (item.type === "video") {
    // Vídeo: descargar (jerarquía) + capturar frame actual.
    btns.push(
      quickBtn("⬇", "Descargar vídeo", {
        cls: "act-dl",
        holdable: true,
        onActivate: (ind) => downloadOne(item, ind),
      })
    );
    btns.push(
      quickBtn("◉", "Descargar frame actual del vídeo", {
        cls: "act-frame",
        holdable: true,
        onActivate: async () => {
          const v = card ? card.querySelector("video") : null;
          if (!v) { statusText.textContent = "Frame no disponible (el vídeo no está en el DOM)."; return; }
          try {
            const blob = await captureFrame(v, "image/jpeg");
            await downloadFrame(blob, `${itemName(item).replace(/\.[^.]+$/, "")}-frame.jpg`);
            toast("Frame guardado");
          } catch (e) {
            statusText.textContent = `No se pudo capturar el frame: ${e.message}`;
          }
        },
      })
    );
  } else if (item.type === "audio") {
    btns.push(
      quickBtn("⬇", "Descargar audio", {
        cls: "act-dl",
        holdable: true,
        onActivate: (ind) => downloadOne(item, ind),
      })
    );
  } else {
    btns.push(
      quickBtn("⬇", "Descargar archivo", {
        cls: "act-dl",
        holdable: true,
        onActivate: (ind) => downloadOne(item, ind),
      })
    );
  }
  return btns;
}

// --- Render ---
function showSkeletons() {
  grid.textContent = "";
  const hosts = state.masonryCols || [grid];
  for (let i = 0; i < 12; i++) {
    const s = document.createElement("div");
    s.className = "card skeleton";
    const t = document.createElement("div");
    t.className = "card-thumb";
    const b = document.createElement("div");
    b.className = "card-body";
    s.append(t, b);
    hosts[i % hosts.length].appendChild(s);
  }
  empty.hidden = true;
}

function emptyReason() {
  const total = state.items.length;
  if (total === 0) {
    if (state.reachable === false) {
      return {
        title: "Página no escaneable",
        hint: "Página del sistema (chrome:// o protegida). Pulsa «Actualizar» para re-escanear en páginas web estándar. Los streams (m3u8/mpd) se capturan solos vía webRequest.",
      };
    }
    return {
      title: "Sin resultados",
      hint: "Pulsa «Actualizar» para re-escaneo. Los streams (m3u8/mpd) se capturan solos vía webRequest.",
    };
  }
  const tabTotal = counts()[state.tab];
  if (tabTotal === 0) {
    const others = TABS.filter((t) => t !== state.tab && counts()[t] > 0);
    return {
      title: `No hay ${TAB_LABELS[state.tab].toLowerCase()} en esta página`,
      hint:
        others.length > 0
          ? `Hay ${others.map((t) => `${counts()[t]} en ${TAB_LABELS[t]}`).join(" y ")}. Cambia de pestaña arriba.`
          : "Cambia de pestaña o pulsa «Actualizar».",
    };
  }
  if (hasActiveFilters()) {
    return {
      title: "Nada coincide con los filtros",
      hint: "Ajusta la búsqueda, el tamaño mínimo, la extensión o el dominio.",
    };
  }
  if (viewPrefs.hideSmall) {
    return {
      title: `Todo oculto por «ocultar <10 KB»`,
      hint: `Los ${tabTotal} ${TAB_LABELS[state.tab].toLowerCase()} de esta vista pesan menos de 10 KB. Desmarca la opción para verlos.`,
    };
  }
  return { title: "Nada coincide con los filtros", hint: "Ajusta la búsqueda o los filtros." };
}

function render() {
  const c = counts();
  document.getElementById("countImage").textContent = c.image;
  document.getElementById("countVideo").textContent = c.video;
  document.getElementById("countAudio").textContent = c.audio;
  document.getElementById("countFile").textContent = c.file;

  // Contador dinámico de la pestaña activa (si existe en el DOM)
  if (counterText) {
    if (loading) {
      counterText.textContent = "Escaneando…";
    } else {
      const n = c[state.tab];
      const lab = COUNTER_LABELS[state.tab];
      counterText.textContent = `${n} ${n === 1 ? lab.s : lab.p} ${n === 1 ? `encontrad${lab.v}` : `encontrad${lab.v}s`}`;
    }
  }

  // Nunca se muestra el vacío mientras se renderizan skeletons.
  if (loading) {
    showSkeletons();
    return;
  }

  const visible = sortedItems();
  lastFiltered = visible;
  dupMap = dupKeysOf(visible);
  state.rendered = 0;
  grid.className = "grid" + (viewPrefs.view === "masonry" ? " masonry-view" : " list-view");
  grid.style.setProperty("--thumb", `${viewPrefs.thumb}px`);
  grid.textContent = "";
  // En masonry las cards viven en columnas flex (masonry real estilo Pinterest,
  // scroll vertical). En list-view el sentinel va directo como último hijo.
  const masonry = viewPrefs.view === "masonry";
  state.masonryCols = masonry ? buildMasonryCols() : null;
  const hosts = masonry ? state.masonryCols : [grid];
  state.activeSentinel = null;
  hosts.forEach((host) => {
    const s = sentinel.cloneNode(true);
    host.appendChild(s);
    state.activeSentinel = s; // el último (fondo de la última columna) gobierna el lazy-render
  });
  updateSelectionUI();

  if (visible.length === 0) {
    empty.hidden = false;
    const r = emptyReason();
    emptyTitle.textContent = r.title;
    emptyHint.textContent = r.hint;
    btnEmptyReset.hidden = !hasActiveFilters();
    observer.disconnect();
    // Diagnóstico permanente: grid vacío con items presentes = estado anómalo.
    // Loguea el snapshot exacto de datos crudos, filtros y pestaña activa.
    if (state.items.length > 0) {
      console.warn("[operant] grid vacío con items presentes", {
        total: state.items.length,
        tab: state.tab,
        tabTotal: c[state.tab],
        filtros: {
          q: search.value,
          minKb: Number(fMinSize.value || 0) || 0,
          ext: fExt.value,
          domain: fDomain.value,
          hideSmall: viewPrefs.hideSmall,
        },
      });
    }
    return;
  }

  empty.hidden = true;
  renderChunk(visible);
  if (state.activeSentinel) observer.observe(state.activeSentinel);

  // Si hay items visibles sin tamaño, pedir los tamaños al SW (resuelve los
  // "…" que entraron tarde por cualquier vía).
  if (visible.some((i) => i.sizeKB === null && !i.sizeUnknown)) requestMissingSizes();
}

// Crea las columnas del masonry según el ancho del grid (estilo Pinterest).
// El número de columnas se deriva de --thumb para que encaje con el slider.
function buildMasonryCols() {
  const cols = Math.max(2, Math.floor((grid.clientWidth - 8) / (viewPrefs.thumb + 8)));
  const hosts = [];
  for (let i = 0; i < cols; i++) {
    const col = document.createElement("div");
    col.className = "masonry-col";
    grid.appendChild(col);
    hosts.push(col);
  }
  return hosts;
}

// Reparte el próximo lote entre columnas: la card va siempre a la columna
// visualmente más corta para mantener el aspecto escalonado del masonry.
function masonryHostFor() {
  let best = state.masonryCols[0];
  let bestH = Infinity;
  for (const col of state.masonryCols) {
    const h = col.offsetHeight;
    if (h < bestH) {
      bestH = h;
      best = col;
    }
  }
  return best;
}

function renderChunk(items) {
  const end = Math.min(state.rendered + RENDER_CHUNK, items.length);
  const fullView = viewPrefs.view !== "masonry";
  for (let i = state.rendered; i < end; i++) {
    if (fullView) {
      grid.appendChild(renderListCard(items[i], i));
    } else {
      masonryHostFor().appendChild(renderCard(items[i], i));
    }
  }
  state.rendered = end;
  if (state.rendered >= items.length) observer.disconnect();
}

function placeholderEl(label, sub) {
  const ph = document.createElement("div");
  ph.className = "placeholder";
  const line = document.createElement("div");
  line.textContent = label;
  ph.appendChild(line);
  if (sub) {
    const s = document.createElement("div");
    s.textContent = sub;
    ph.appendChild(s);
  }
  return ph;
}

function previewErrEl(title, reason) {
  const box = document.createElement("div");
  box.className = "preview-err";
  const t = document.createElement("b");
  t.textContent = title;
  const r = document.createElement("span");
  r.textContent = reason;
  box.append(t, r);
  return box;
}

function renderCard(item, index) {
  const card = document.createElement("article");
  card.className = "card";
  if (state.selected.has(item.url)) card.classList.add("selected");
  if (viewPrefs.dupes && item.type === "image" && dupMap.has(item.url)) card.classList.add("dup");

  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  if (viewPrefs.view === "masonry") {
    thumb.style.height = ""; // masonry: altura natural según el contenido
  }

  const blobUrl = item.url.startsWith("blob:");

  if (item.type === "image") {
    if (blobUrl) {
      thumb.appendChild(placeholderEl("IMG", "blob:"));
    } else {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.src = item.url;
      img.addEventListener("error", () => {
        if (item.thumb && img.src !== item.thumb) {
          img.src = item.thumb;
        } else if (img.parentNode) {
          img.replaceWith(placeholderEl("IMG", "preview no disponible"));
        }
      });
      if (item.w && item.h) {
        img.style.aspectRatio = `${item.w} / ${item.h}`;
        img.style.objectFit = "contain";
      }
      thumb.appendChild(img);
    }
  } else if (item.type === "video") {
    // Respetar el aspect ratio real del vídeo si se conocen dimensiones.
    if (item.w && item.h) {
      thumb.classList.add("has-ratio");
      thumb.style.setProperty("--video-ratio", `${item.w} / ${item.h}`);
    }
    if (item.thumb && !blobUrl) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = item.thumb;
      img.addEventListener("error", () => {
        if (img.parentNode) img.replaceWith(placeholderEl("▶", item.embed || "VIDEO"));
      });
      thumb.appendChild(img);
    } else if (!item.embed && !blobUrl && !/\.(m3u8|mpd)(?:[?#].*)?$/i.test(item.url)) {
      // Vídeo directo sin thumbnail: mostrar el primer fotograma real.
      const placeholder = placeholderEl("▶", item.ext || "VIDEO");
      thumb.appendChild(placeholder);
      videoFirstFrame(item.url).then((dataUrl) => {
        if (!dataUrl || !placeholder.isConnected) return;
        placeholder.replaceWith(Object.assign(document.createElement("img"), { src: dataUrl, alt: "", className: "vid-frame", loading: "lazy" }));
      }).catch(() => {});
    } else {
      thumb.appendChild(placeholderEl("▶", item.embed || item.ext || "VIDEO"));
    }
    if (!item.embed && !blobUrl && !/\.mpd($|[?#])/i.test(item.url)) {
      setupVideoHover(card, thumb, item);
    }
    const play = document.createElement("span");
    play.className = "badge media-play";
    play.textContent = "▶";
    thumb.appendChild(play);
  } else if (item.type === "audio") {
    thumb.appendChild(placeholderEl("♪", item.ext || "AUDIO"));
    const play = document.createElement("span");
    play.className = "badge media-play";
    play.textContent = "♪";
    thumb.appendChild(play);
  } else {
    thumb.appendChild(placeholderEl("FILE", item.ext || ""));
  }

  const badge = document.createElement("span");
  badge.className = "badge" + (item.source === "network" ? " network" : "");
  badge.textContent = item.ext || item.type;
  thumb.appendChild(badge);
  // Badge de método (transparencia de la jerarquía de vídeo): solo para media.
  if (item.type === "video" || item.type === "audio") {
    thumb.appendChild(methodBadge(item));
  }
  if (viewPrefs.dupes && dupMap.has(item.url)) {
    const dupBadge = document.createElement("span");
    dupBadge.className = "badge dup";
    dupBadge.textContent = "duplicado";
    thumb.appendChild(dupBadge);
  }

  // Hover: preview ampliado (imágenes) — bajo demanda con filtro estricto de tamaño.
  if (item.type === "image" && !blobUrl) {
    setupImageHover(card, thumb, item);
  }

  // Número de tarjeta en la esquina inferior derecha del thumbnail (libre).
  thumb.appendChild(cardNumberBadge(index));

  card.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "card-body";

  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = itemName(item);
  name.title = item.url;
  body.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = metaString(item);
  body.appendChild(meta);

  // Acciones por card (grid/masonry): overlay en la esquina superior, hover.
  // La vista lista usa su propia toolbar (renderListCard).
  const actions = document.createElement("div");
  actions.className = "card-actions-overlay";

  const preview = document.createElement("button");
  preview.className = "icon-btn";
  preview.textContent = "⤢";
  preview.title = "Abrir preview";
  preview.setAttribute("aria-label", "Preview");
  preview.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openPreview(item);
  });

  const sel = document.createElement("button");
  sel.className = "icon-btn";
  sel.textContent = state.selected.has(item.url) ? "✓" : "+";
  sel.title = "Seleccionar (Shift+clic = rango, Ctrl+clic = alternar)";
  sel.setAttribute("aria-label", "Seleccionar");
  if (state.selected.has(item.url)) sel.classList.add("sel-on");
  sel.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handleSelectClick(item.url, index, ev);
    sel.textContent = state.selected.has(item.url) ? "✓" : "+";
    sel.classList.toggle("sel-on", state.selected.has(item.url));
    card.classList.toggle("selected", state.selected.has(item.url));
    updateSelectionUI();
  });

  // Botones de acción por tipo (descarga / frame), con hover-para-revelar.
  actions.append(preview, ...typeActionButtons(item, index, card), sel);
  thumb.appendChild(actions);

  card.appendChild(body);

  // Clic en la tarjeta: preview (lightbox/reproductor). Ctrl/Shift = selección.
  card.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) return;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      handleSelectClick(item.url, index, ev);
      sel.textContent = state.selected.has(item.url) ? "✓" : "+";
      sel.classList.toggle("sel-on", state.selected.has(item.url));
      card.classList.toggle("selected", state.selected.has(item.url));
      updateSelectionUI();
      return;
    }
    openPreview(item);
  });

  return card;
}

// --- Vista lista (POR DEFECTO, estilo ImageEye) ---
// Una fila por item, ancho completo: metadata arriba (formato · dimensiones ·
// peso, a la derecha), imagen a su aspect ratio real (max-height 420px),
// URL de origen debajo (truncada, tooltip completo), toolbar flotante al hover.

function lcBadge(text, cls) {
  const b = document.createElement("span");
  b.className = `lc-badge ${cls || ""}`;
  b.textContent = text;
  return b;
}

function lcToolBtn(glyph, label, fn) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    fn();
  });
  return b;
}

function renderListCard(item, index) {
  const card = document.createElement("article");
  card.className = "card list-card";
  if (state.selected.has(item.url)) card.classList.add("selected");
  if (viewPrefs.dupes && item.type === "image" && dupMap.has(item.url)) card.classList.add("dup");

  // Metadata arriba, alineada a la derecha: formato · dimensiones · peso · duración
  const meta = document.createElement("div");
  meta.className = "lc-meta";
  meta.appendChild(cardNumberBadge(index));
  meta.appendChild(lcBadge(item.ext ? item.ext.toUpperCase() : item.type, "fmt"));
  const dimBadge = lcBadge(item.w && item.h ? `${item.w}×${item.h}` : "", "dim");
  dimBadge.hidden = !(item.w && item.h);
  meta.appendChild(dimBadge);
  meta.appendChild(lcBadge(formatSize(item.sizeKB, item.sizeUnknown), "size"));
  if (item.durationSec) meta.appendChild(lcBadge(formatDuration(item.durationSec), "dur"));
  if (item.type === "video" || item.type === "audio") {
    meta.appendChild(lcBadge(methodLabel(item), "method"));
  }
  card.appendChild(meta);

  // Escenario: imagen a su ratio real / placeholder de tipo
  const stage = document.createElement("div");
  stage.className = "lc-stage";

  const blobUrl = item.url.startsWith("blob:");

  if (item.type === "image") {
    if (blobUrl) {
      stage.appendChild(placeholderEl("IMG", "blob:"));
    } else {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.src = item.url;
      img.addEventListener("error", () => {
        if (item.thumb && img.src !== item.thumb) {
          img.src = item.thumb;
        } else if (img.parentNode) {
          img.replaceWith(placeholderEl("IMG", "preview no disponible"));
        }
      });
      // Medición real al cargar: rellena el badge de dimensiones si faltaba.
      img.addEventListener("load", () => {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!nw || !nh) return;
        if (item.w !== nw || item.h !== nh) {
          item.w = nw;
          item.h = nh;
          if (dimBadge.hidden) {
            dimBadge.hidden = false;
            dimBadge.textContent = `${nw}×${nh}`;
          }
        }
      });
      stage.appendChild(img);
    }
  } else if (item.type === "video") {
    // Respetar el aspect ratio real del vídeo si se conocen dimensiones.
    if (item.w && item.h) {
      stage.classList.add("has-ratio");
      stage.style.setProperty("--video-ratio", `${item.w} / ${item.h}`);
    }
    if (item.thumb && !blobUrl) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = item.thumb;
      img.addEventListener("error", () => {
        if (img.parentNode) img.replaceWith(placeholderEl("▶", item.embed || "VIDEO"));
      });
      stage.appendChild(img);
    } else if (!item.embed && !blobUrl && !/\.(m3u8|mpd)(?:[?#].*)?$/i.test(item.url)) {
      // Vídeo directo (mp4/webm) sin thumbnail: mostrar el PRIMER FOTOGRAMA
      // real capturándolo con un <video> oculto + canvas.
      const placeholder = placeholderEl("▶", item.ext || "VIDEO");
      stage.appendChild(placeholder);
      videoFirstFrame(item.url).then((dataUrl) => {
        if (!dataUrl || !placeholder.isConnected) return;
        placeholder.replaceWith(Object.assign(document.createElement("img"), { src: dataUrl, alt: "", className: "vid-frame", loading: "lazy" }));
      }).catch(() => {});
    } else {
      stage.appendChild(placeholderEl("▶", item.embed || item.ext || "VIDEO"));
    }
    if (!item.embed && !blobUrl && !/\.mpd($|[?#])/i.test(item.url)) {
      setupVideoHover(card, stage, item);
    }
  } else if (item.type === "audio") {
    stage.appendChild(placeholderEl("♪", item.ext || "AUDIO"));
  } else {
    stage.appendChild(placeholderEl("FILE", item.ext || ""));
  }

  // Toolbar flotante (hover): selección · abrir · descargar · zoom
  const tb = document.createElement("div");
  tb.className = "lc-toolbar";

  const sel = lcToolBtn(state.selected.has(item.url) ? "✓" : "+", "Seleccionar", () => {});
  if (state.selected.has(item.url)) sel.classList.add("sel-on");
  sel.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handleSelectClick(item.url, index, ev);
    sel.textContent = state.selected.has(item.url) ? "✓" : "+";
    sel.classList.toggle("sel-on", state.selected.has(item.url));
    card.classList.toggle("selected", state.selected.has(item.url));
    updateSelectionUI();
  });
  tb.appendChild(sel);
  tb.appendChild(lcToolBtn("↗", "Abrir en pestaña nueva", () => {
    chrome.tabs.create({ url: item.url }).catch(() => {});
  }));
  // Botones de acción por tipo (descarga / frame) con hover-para-revelar.
  tb.append(...typeActionButtons(item, index, card));
  tb.appendChild(lcToolBtn("⤢", "Zoom (preview)", () => openPreview(item)));

  stage.appendChild(tb);
  card.appendChild(stage);

  // URL de origen debajo: gris tenue, truncada, tooltip con la URL completa.
  const urlLine = document.createElement("div");
  urlLine.className = "lc-url";
  const isData = item.url.startsWith("data:");
  urlLine.textContent = isData ? `data:${item.ext || "image"} · inline base64 (${formatSize(item.sizeKB, item.sizeUnknown)})` : item.url;
  urlLine.title = isData ? `Imagen embebida (data:${item.ext || "image"})` : item.url;
  card.appendChild(urlLine);

  // Clic en la tarjeta: preview. Ctrl/Shift = selección.
  card.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) return;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      handleSelectClick(item.url, index, ev);
      sel.textContent = state.selected.has(item.url) ? "✓" : "+";
      sel.classList.toggle("sel-on", state.selected.has(item.url));
      card.classList.toggle("selected", state.selected.has(item.url));
      updateSelectionUI();
      return;
    }
    openPreview(item);
  });

  return card;
}

// Hover de imagen: preview ampliado bajo demanda con filtro estricto de tamaño.
// Solo se activa si la imagen real es >= 140px y más grande que el thumbnail renderizado.
function setupImageHover(card, thumb, item) {
  let hoverEl = null;

  const cleanup = () => {
    if (hoverEl) {
      hoverEl.remove();
      hoverEl = null;
    }
  };

  card.addEventListener(
    "mouseenter",
    () => {
      // 1. Si ya se conocen dimensiones y es pequeña (< 140px), descartar
      if (item.w && item.w < 140) return;
      if (item.h && item.h < 140) return;

      // 2. Si el thumbnail ya está en el DOM, verificar dimensiones reales
      const thumbImg = thumb.querySelector("img");
      if (thumbImg && thumbImg.naturalWidth > 0 && thumbImg.naturalHeight > 0) {
        item.w = thumbImg.naturalWidth;
        item.h = thumbImg.naturalHeight;
        // Umbral estricto: descartar iconos, avatares y elementos < 140px
        if (item.w < 140 || item.h < 140) return;
        // Si la imagen es menor o igual al thumbnail en pantalla, no tiene sentido ampliar
        if (item.w <= thumb.clientWidth && item.h <= thumb.clientHeight) return;
      }

      if (hoverEl) return;

      hoverEl = document.createElement("div");
      hoverEl.className = "card-hover";

      const hv = document.createElement("div");
      hv.className = "hover-box";

      const big = document.createElement("img");
      big.alt = "";
      big.src = item.url;

      big.addEventListener("load", () => {
        if (big.naturalWidth > 0 && big.naturalHeight > 0) {
          item.w = big.naturalWidth;
          item.h = big.naturalHeight;
          if (big.naturalWidth < 140 || big.naturalHeight < 140) {
            cleanup();
            return;
          }
        }
      });
      big.addEventListener("error", cleanup);

      hv.appendChild(big);

      const hvMeta = document.createElement("div");
      hvMeta.className = "hover-meta";
      hvMeta.textContent = `${item.url} · ${metaString(item)}`;
      hv.appendChild(hvMeta);

      hoverEl.appendChild(hv);
      thumb.appendChild(hoverEl);
    },
    { passive: true }
  );

  card.addEventListener("mouseleave", cleanup, { passive: true });
  card.addEventListener("click", cleanup);
}

// Hover de vídeo: preview mudo en loop (estilo YouTube).
function setupVideoHover(card, thumb, item) {
  let v = null;
  const stop = () => {
    if (v) {
      v.pause();
      v.src = "";
      v.remove();
      v = null;
    }
  };
  card.addEventListener(
    "mouseenter",
    () => {
      if (v) return;
      v = document.createElement("video");
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.src = item.url;
      v.addEventListener("error", stop);
      v.addEventListener("loadeddata", () => v.play().catch(() => {}));
      v.addEventListener("playing", () => {
        const ph = thumb.querySelector(".placeholder");
        if (ph) ph.remove();
        if (v && v.parentNode !== thumb) thumb.appendChild(v);
      });
      thumb.appendChild(v);
    },
    { passive: true }
  );
  card.addEventListener("mouseleave", stop, { passive: true });
  card.addEventListener("click", stop);
}

// --- Selección ---
function handleSelectClick(url, index, ev) {
  if (ev.shiftKey && lastClickIndex >= 0) {
    const [a, b] = [Math.min(lastClickIndex, index), Math.max(lastClickIndex, index)];
    const range = lastFiltered.slice(a, b + 1);
    const select = !state.selected.has(url);
    for (const it of range) {
      if (select) state.selected.add(it.url);
      else state.selected.delete(it.url);
    }
  } else {
    toggleSelect(url);
  }
  lastClickIndex = index;
  persistSelection();
}

function toggleSelect(url) {
  if (state.selected.has(url)) state.selected.delete(url);
  else state.selected.add(url);
}

function selWeightText() {
  let totalKb = 0;
  let unknown = 0;
  for (const it of state.items) {
    if (!state.selected.has(it.url)) continue;
    if (it.sizeKB && !it.sizeUnknown) totalKb += it.sizeKB;
    else unknown++;
  }
  if (!totalKb) return `${unknown} sin tamaño`;
  const sizeTxt = totalKb < 1024 * 1024 ? `${(totalKb / 1024).toFixed(1)} MB` : `${(totalKb / (1024 * 1024)).toFixed(2)} GB`;
  return unknown ? `~${sizeTxt} (+${unknown} sin tamaño)` : `~${sizeTxt}`;
}

function updateSelectionUI() {
  const c = state.selected.size;
  const vis = lastFiltered.length;
  selInfo.hidden = c === 0;
  if (c > 0) selInfo.textContent = `${c} sel · ${selWeightText()}`;
  btnClearSel.hidden = c === 0;
  chkSelectAll.checked = vis > 0 && lastFiltered.every((it) => state.selected.has(it.url));
  const zipN = c > 0 ? c : vis;
  btnZip.textContent = zipN > 0 ? `Zip (${zipN})` : "Zip";
  btnZip.disabled = zipN === 0;
}

function persistSelection() {
  clearTimeout(persistSelection._t);
  persistSelection._t = setTimeout(() => {
    chrome.storage.local.set({ selUrls: [...state.selected].slice(0, 400) }).catch(() => {});
  }, 300);
}

async function applyPersistedSelection() {
  if (state.selHydrated) return;
  try {
    const data = await chrome.storage.local.get(["selUrls"]);
    const urls = new Set(data.selUrls || []);
    for (const it of state.items) {
      if (urls.has(it.url)) state.selected.add(it.url);
    }
  } catch {
    /* sin selección persistida */
  }
  state.selHydrated = true;
  persistSelection();
}

chkSelectAll.addEventListener("change", () => {
  for (const it of lastFiltered) {
    if (chkSelectAll.checked) state.selected.add(it.url);
    else state.selected.delete(it.url);
  }
  updateSelectionUI();
  persistSelection();
  render();
});

btnClearSel.addEventListener("click", () => {
  state.selected.clear();
  updateSelectionUI();
  persistSelection();
  render();
});

// --- Previews ---
function openPreview(item) {
  if (item.type === "image") openLightbox(item);
  else if (item.type === "video") openVideoPlayer(item);
  else if (item.type === "audio") openAudioPlayer(item);
  else if (item.type === "file" && /\.pdf($|[?#])/i.test(item.url)) openPdfPreview(item);
  else chrome.tabs.create({ url: item.url }).catch(() => {});
}

// --- Progreso real de escaneo (barra "Analizando X de Y elementos") ---
const SCAN_PHASE_LABELS = {
  inicio: "Iniciando análisis",
  "imágenes": "Escaneando imágenes DOM",
  enlaces: "Extrayendo enlaces de alta resolución",
  atributos: "Analizando atributos y metadatos",
  medios: "Detectando vídeos y audio",
  estilos: "Evaluando estilos y fondos CSS",
  done: "Escaneo completado",
};

let scanHideTimer = null;

function showScanProgress(done, total, phase, found) {
  clearTimeout(scanHideTimer);
  scanBar.hidden = false;

  const count = typeof found === "number" && found >= 0 ? Math.max(found, state.items.length) : state.items.length;

  if (phase === "scroll" || (typeof phase === "string" && phase.startsWith("scroll "))) {
    // Fase de auto-scroll: mostramos el paso en curso + botón de detener.
    const step = phase.split(" ")[1] || "";
    scanFill.style.width = "100%";
    scanText.textContent = `Auto-scroll (${step}) · ${count} medio${count === 1 ? "" : "s"} detectado${count === 1 ? "" : "s"}`;
    btnStopScan.hidden = false;
    scanHideTimer = setTimeout(() => {
      scanBar.hidden = true;
      btnStopScan.hidden = true;
    }, 3000);
    return;
  }

  if (phase === "done" || (total > 0 && done >= total)) {
    btnStopScan.hidden = true;
    scanFill.style.width = "100%";
    scanText.textContent = `Escaneo completado · ${count} medio${count === 1 ? "" : "s"} detectado${count === 1 ? "" : "s"} (100%)`;
    scanHideTimer = setTimeout(() => {
      scanBar.hidden = true;
    }, 450);
    return;
  }

  btnStopScan.hidden = true;
  const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
  scanFill.style.width = `${pct}%`;

  const label = SCAN_PHASE_LABELS[phase] || "Analizando página";
  scanText.textContent = `${label} (${pct}%) · ${count} medio${count === 1 ? "" : "s"} detectado${count === 1 ? "" : "s"}`;

  scanHideTimer = setTimeout(() => {
    scanBar.hidden = true;
  }, 4000);
}

// Captura el PRIMER fotograma de un vídeo directo (mp4/webm) para usarlo como
// thumbnail en la card. Usa un <video> oculto + canvas; devuelve dataURL o null.
function videoFirstFrame(src) {
  return new Promise((resolve) => {
    try {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.src = src;
      v.crossOrigin = "anonymous";
      let done = false;
      const finish = (url) => {
        if (done) return;
        done = true;
        v.removeAttribute("src");
        v.load();
        resolve(url);
      };
      const timer = setTimeout(() => finish(null), 8000);
      v.addEventListener("loadeddata", () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth || 640;
          canvas.height = v.videoHeight || 360;
          const ctx = canvas.getContext("2d");
          if (!ctx) { clearTimeout(timer); finish(null); return; }
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          clearTimeout(timer);
          finish(canvas.toDataURL("image/jpeg", 0.7));
        } catch {
          clearTimeout(timer);
          finish(null);
        }
      }, { once: true });
      v.addEventListener("error", () => { clearTimeout(timer); finish(null); }, { once: true });
    } catch {
      resolve(null);
    }
  });
}

// --- Lightbox de imágenes (zoom con rueda / botones + navegación) ---
let lbList = [];
let lbIndex = -1;
let lbZoom = 1;
const LB_MAX = 6;
const LB_MIN = 0.25;

function applyLbZoom() {
  lbZoom = Math.min(LB_MAX, Math.max(LB_MIN, lbZoom));
  lbImg.style.transform = `scale(${lbZoom})`;
  lbImg.style.cursor = lbZoom > 1 ? "zoom-out" : "zoom-in";
  lbZoomVal.textContent = `${Math.round(lbZoom * 100)}%`;
}

function showLbErr(text) {
  lbErr.hidden = false;
  lbErr.textContent = text;
}

function lbShow() {
  const item = lbList[lbIndex];
  if (!item) return;
  lbZoom = 1;
  lbTitle.textContent = itemName(item);
  lbMeta.textContent = `${item.url} · ${metaString(item)}`;
  lbErr.hidden = true;
  lbImg.style.transform = "";
  applyLbZoom();
  lbImg.referrerPolicy = "no-referrer";
  if (item.url.startsWith("blob:")) {
    showLbErr("URL blob: de la página — no se puede previsualizar desde el panel. Prueba a descargarla.");
    lbImg.onerror = null;
    lbImg.src = "";
  } else {
    lbImg.onerror = () => {
      if (item.thumb && lbImg.src !== item.thumb) {
        lbImg.src = item.thumb;
        showLbErr("Mostrando miniatura de la página (el servidor externo bloqueó el acceso por CORS/403).");
      } else {
        showLbErr("No se pudo cargar la imagen (CORS, 404 o contenido protegido).");
      }
    };
    lbImg.src = item.url;
  }
  lbPrev.hidden = lbIndex <= 0;
  lbNext.hidden = lbIndex >= lbList.length - 1;
}

function openLightbox(item) {
  // Navegación sobre las imágenes visibles (filtradas) de la vista actual.
  lbList = lastFiltered.filter((it) => it.type === "image" && !it.url.startsWith("blob:"));
  lbIndex = lbList.findIndex((it) => it.url === item.url);
  if (lbIndex < 0) {
    lbList = [item];
    lbIndex = 0;
  }
  lbShow();
  lightboxDialog.showModal();
}

function lbNav(delta) {
  if (lbList.length < 2) return;
  const next = lbIndex + delta;
  if (next < 0 || next >= lbList.length) return;
  lbIndex = next;
  lbShow();
}

lbPrev.addEventListener("click", () => lbNav(-1));
lbNext.addEventListener("click", () => lbNav(1));

// Teclado dentro del lightbox: ← → navegan, Esc cierra.
lightboxDialog.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") {
    lbNav(-1);
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    lbNav(1);
    e.preventDefault();
  }
});

// Swipe táctil (izquierda/derecha) en el escenario del lightbox.
let lbTouchX = 0;
lbStage.addEventListener("touchstart", (e) => {
  lbTouchX = e.touches[0].clientX;
}, { passive: true });
lbStage.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - lbTouchX;
  if (Math.abs(dx) > 40) lbNav(dx > 0 ? -1 : 1);
}, { passive: true });

lbZoomIn.addEventListener("click", () => {
  lbZoom *= 1.5;
  applyLbZoom();
});
lbZoomOut.addEventListener("click", () => {
  lbZoom /= 1.5;
  applyLbZoom();
});
lbReset.addEventListener("click", () => {
  lbZoom = 1;
  applyLbZoom();
});
lbClose.addEventListener("click", () => lightboxDialog.close());
lightboxDialog.addEventListener("cancel", () => lightboxDialog.close());
lbStage.addEventListener("wheel", (e) => {
  if (!lightboxDialog.open) return;
  e.preventDefault();
  lbZoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  applyLbZoom();
}, { passive: false });
lbImg.addEventListener("click", () => {
  lbZoom = lbZoom > 1 ? 1 : 2;
  applyLbZoom();
});
lbDownload.addEventListener("click", () => {
  if (lbList[lbIndex]) downloadOne(lbList[lbIndex]);
});
lbOpen.addEventListener("click", () => {
  if (lbList[lbIndex]) chrome.tabs.create({ url: lbList[lbIndex].url }).catch(() => {});
});

// --- Reproductor de vídeo (controles nativos + HLS vía hls.js + DASH vía dash.js) ---
let hlsInstance = null;
let dashInstance = null;
let vdItem = null;

function showVdErr(text) {
  vdErr.hidden = false;
  vdErr.textContent = text;
}

// Construye la URL del iframe del player real para un embed detectado.
function embedIframeUrl(item) {
  const id = item.embedId;
  try {
    const u = new URL(item.url);
    const host = u.hostname;
    if (item.embed === "youtube") {
      const vid = id || u.searchParams.get("v") || (u.pathname.match(/\/(?:embed|shorts)\/([\w-]+)/) || [])[1] || u.pathname.split("/").filter(Boolean).pop();
      return vid ? `https://www.youtube-nocookie.com/embed/${vid}` : null;
    }
    if (item.embed === "vimeo") {
      const v = id || u.pathname.match(/(\d+)/)?.[1];
      return v ? `https://player.vimeo.com/video/${v}` : null;
    }
    if (item.embed === "dailymotion") {
      const d = id || u.pathname.match(/(?:video|embed\/video)\/([\w]+)/)?.[1];
      return d ? `https://www.dailymotion.com/embed/video/${d}` : null;
    }
    if (item.embed === "twitter") {
      // X/Twitter no tiene iframe embed público directo; devolver null -> usa yt-dlp.
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

// Metadata real del embed vía oEmbed (título, thumbnail) — APIs públicas.
async function fetchEmbedMeta(item) {
  let endpoint = "";
  try {
    const u = new URL(item.url);
    if (item.embed === "youtube") {
      const vid = u.searchParams.get("v") || (u.pathname.match(/(?:embed|shorts)\/([\w-]+)/) || [])[1] || u.pathname.split("/").filter(Boolean).pop();
      endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}&format=json`;
    } else if (item.embed === "vimeo") {
      const v = u.pathname.match(/(\d+)/)?.[1];
      endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${v}`)}`;
    } else if (item.embed === "dailymotion") {
      endpoint = `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(item.url)}&format=json`;
    }
    if (!endpoint) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(endpoint, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function openVideoPlayer(item) {
  vdItem = item;
  vdTitle.textContent = itemName(item);
  vdMeta.textContent = `${item.url} · ${metaString(item)}`;
  vdErr.hidden = true;
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  if (dashInstance) {
    dashInstance.destroy();
    dashInstance = null;
  }
  vdEl.pause();
  vdEl.removeAttribute("src");
  vdEl.load();

  if (item.embed) {
    // Preview REAL del embed: incrustar el iframe del player de la plataforma.
    const embedUrl = embedIframeUrl(item);
    if (embedUrl) {
      vdEmbed.textContent = "";
      const frame = document.createElement("iframe");
      frame.src = embedUrl;
      frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      frame.allowFullscreen = true;
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      vdEmbed.appendChild(frame);
      vdEmbed.hidden = false;
      vdEl.hidden = true;
      // Título real vía oEmbed (metadata, no solo el iframe).
      fetchEmbedMeta(item).then((meta) => {
        if (meta && meta.title) vdTitle.textContent = meta.title;
      }).catch(() => {});
    } else {
      showVdErr(`Vídeo embebido (${item.embed}): no se pudo construir el player. Usa el botón yt-dlp.`);
    }
    videoDialog.showModal();
    return;
  }
  // Limpiar el iframe si lo había de una vista previa anterior.
  vdEmbed.hidden = true;
  vdEmbed.textContent = "";
  vdEl.hidden = false;
  if (item.url.startsWith("blob:")) {
    // El objeto blob vive en el contexto de la página: el panel no puede
    // reproducirlo directamente (inviable por diseño del navegador). Si el
    // content script capturó metadata real del <video> en vivo, se muestra.
    const metaBits = [];
    if (item.durationSec) metaBits.push(`duración ${formatDuration(item.durationSec)}`);
    if (item.w && item.h) metaBits.push(`${item.w}×${item.h}`);
    showVdErr(
      "Vídeo blob: de la página (stream en memoria, no accesible desde el panel)." +
        (metaBits.length ? ` ${metaBits.join(" · ")}.` : "") +
        " Descárgalo desde la card (el content script puede leer el blob)."
    );
    videoDialog.showModal();
    return;
  }
  if (/\.mpd($|[?#])/i.test(item.url)) {
    // DASH (.mpd): reproducir con dash.js (equivalente a hls.js pero para DASH).
    if (window.dashjs && dashjs.MediaPlayer) {
      try {
        const dash = dashjs.MediaPlayer().create();
        dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
          showVdErr(`DASH: ${(e && e.error && e.error.message) || "error de stream"} — CORS o segmentos inaccesibles. Usa yt-dlp.`);
        });
        dash.initialize(vdEl, item.url, true);
        dashInstance = dash;
      } catch {
        showVdErr("No se pudo iniciar la reproducción DASH. Usa yt-dlp para descargarlo.");
      }
    } else {
      showVdErr("DASH no soportado en este navegador: usa el botón yt-dlp.");
    }
  } else if (/\.m3u8($|[?#])/i.test(item.url)) {
    if (window.Hls && Hls.isSupported()) {
      try {
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            showVdErr(`HLS: ${data.details || "error de stream"} — CORS o segmentos inaccesibles. Usa yt-dlp.`);
          }
        });
        hls.loadSource(item.url);
        hls.attachMedia(vdEl);
        hlsInstance = hls;
      } catch {
        showVdErr("No se pudo iniciar la reproducción HLS.");
      }
    } else if (vdEl.canPlayType("application/vnd.apple.mpegurl")) {
      vdEl.src = item.url;
    } else {
      showVdErr("HLS no soportado en este navegador: usa el botón yt-dlp.");
    }
  } else {
    vdEl.src = item.url;
    vdEl.addEventListener(
      "error",
      () => showVdErr("No se pudo cargar el vídeo (CORS, formato no soportado o contenido protegido)."),
      { once: true }
    );
  }
  videoDialog.showModal();
  vdEl.play().catch(() => {});
}

vdClose.addEventListener("click", () => videoDialog.close());
videoDialog.addEventListener("cancel", () => videoDialog.close());
videoDialog.addEventListener("close", () => {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  if (dashInstance) {
    dashInstance.destroy();
    dashInstance = null;
  }
  vdEl.pause();
  vdEl.removeAttribute("src");
});
vdDownload.addEventListener("click", () => {
  if (vdItem) downloadOne(vdItem);
});
vdOpen.addEventListener("click", () => {
  if (vdItem) chrome.tabs.create({ url: vdItem.url }).catch(() => {});
});

// --- Reproductor de audio ---
let adItem = null;

function showAdErr(text) {
  adErr.hidden = false;
  adErr.textContent = text;
}

function openAudioPlayer(item) {
  adItem = item;
  adTitle.textContent = itemName(item);
  adMeta.textContent = `${item.url} · ${metaString(item)}`;
  adErr.hidden = true;
  adEl.pause();
  adEl.removeAttribute("src");
  adEl.load();
  if (item.url.startsWith("blob:")) {
    showAdErr("URL blob: de la página — no accesible desde el panel. Prueba a descargarla.");
  } else {
    adEl.src = item.url;
    adEl.addEventListener(
      "error",
      () => showAdErr("No se pudo cargar el audio (CORS, formato no soportado o contenido protegido)."),
      { once: true }
    );
  }
  audioDialog.showModal();
  adEl.play().catch(() => {});
}

adClose.addEventListener("click", () => audioDialog.close());
audioDialog.addEventListener("cancel", () => audioDialog.close());
audioDialog.addEventListener("close", () => {
  adEl.pause();
  adEl.removeAttribute("src");
});
adDownload.addEventListener("click", () => {
  if (adItem) downloadOne(adItem);
});
adOpen.addEventListener("click", () => {
  if (adItem) chrome.tabs.create({ url: adItem.url }).catch(() => {});
});

// --- Preview de PDF (embebido en el panel) ---
let pdfItem = null;
const pdfDialog = document.getElementById("pdfDialog");
const pdfTitle = document.getElementById("pdfTitle");
const pdfFrame = document.getElementById("pdfFrame");
const pdfErr = document.getElementById("pdfErr");
const pdfDownload = document.getElementById("pdfDownload");
const pdfOpen = document.getElementById("pdfOpen");
const pdfClose = document.getElementById("pdfClose");

function openPdfPreview(item) {
  pdfItem = item;
  pdfTitle.textContent = itemName(item);
  pdfErr.hidden = true;
  pdfFrame.src = item.url; // Chrome renderiza PDF nativamente en iframes
  pdfDialog.showModal();
}

pdfClose.addEventListener("click", () => pdfDialog.close());
pdfDialog.addEventListener("cancel", () => pdfDialog.close());
pdfDialog.addEventListener("close", () => {
  pdfFrame.src = "";
});
pdfDownload.addEventListener("click", () => {
  if (pdfItem) downloadOne(pdfItem);
});
pdfOpen.addEventListener("click", () => {
  if (pdfItem) chrome.tabs.create({ url: pdfItem.url }).catch(() => {});
});

// --- Popover de filtros / vista ---
function closePopover() {
  filterPop.hidden = true;
  btnFilter.classList.remove("active");
  btnFilter.setAttribute("aria-expanded", "false");
}

btnFilter.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = filterPop.hidden;
  filterPop.hidden = !open;
  btnFilter.classList.toggle("active", open);
  btnFilter.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (e) => {
  if (filterPop.hidden) return;
  if (!filterPop.contains(e.target) && e.target !== btnFilter && !btnFilter.contains(e.target)) {
    closePopover();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !filterPop.hidden) {
    closePopover();
    e.stopPropagation();
  }
});

function clearFilters() {
  search.value = "";
  fMinSize.value = "0";
  fExt.value = "";
  fDomain.value = "";
  viewPrefs.hideSmall = false;
  chkHideSmall.checked = false;
  saveViewPrefs();
  render();
}

btnClearFilters.addEventListener("click", clearFilters);
btnEmptyReset.addEventListener("click", clearFilters);

// --- Vistas / ordenación / tamaño / filtros (persistidos) ---
async function saveViewPrefs() {
  viewPrefs.tab = state.tab;
  viewPrefs.fMinSize = fMinSize.value;
  viewPrefs.fExt = fExt.value;
  viewPrefs.fDomain = fDomain.value;
  try {
    await chrome.storage.local.set({ viewPrefs });
  } catch {
    /* almacenamiento no disponible */
  }
}

async function loadViewPrefs() {
  let data = {};
  try {
    data = await chrome.storage.local.get(["viewPrefs"]);
  } catch {
    data = {};
  }
  Object.assign(viewPrefs, data.viewPrefs || {});
  // Migración: las vistas grid/list de versiones anteriores desaparecen.
  if (!TABS_VIEWS.includes(viewPrefs.view)) viewPrefs.view = "full";
  if (!viewPrefs.sort || viewPrefs.sort === "detect" || viewPrefs.sort === "size") viewPrefs.sort = "smart";
  layoutSel.value = viewPrefs.view;
  sortBy.value = viewPrefs.sort;
  thumbSize.value = viewPrefs.thumb;
  thumbVal.textContent = viewPrefs.thumb;
  dlMode.value = viewPrefs.hoverDl === "hold" ? "hold" : "click";
  chkHideSmall.checked = !!viewPrefs.hideSmall;
  chkDupes.checked = viewPrefs.dupes !== false;
  fMinSize.value = viewPrefs.fMinSize || "0";
  fDomain.value = viewPrefs.fDomain || "";
  if (TABS.includes(viewPrefs.tab)) state.tab = viewPrefs.tab;
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
}

const TABS_VIEWS = ["full", "masonry"];

layoutSel.addEventListener("change", () => {
  viewPrefs.view = layoutSel.value;
  saveViewPrefs();
  render();
});

sortBy.addEventListener("change", () => {
  viewPrefs.sort = sortBy.value;
  saveViewPrefs();
  render();
});

thumbSize.addEventListener("input", () => {
  viewPrefs.thumb = Number(thumbSize.value);
  thumbVal.textContent = viewPrefs.thumb;
  clearTimeout(thumbSize._t);
  thumbSize._t = setTimeout(() => {
    saveViewPrefs();
    render();
  }, 60);
});

dlMode.addEventListener("change", () => {
  viewPrefs.hoverDl = dlMode.value === "hold" ? "hold" : "click";
  saveViewPrefs();
  render();
});

chkHideSmall.addEventListener("change", () => {
  viewPrefs.hideSmall = chkHideSmall.checked;
  saveViewPrefs();
  render();
});

chkDupes.addEventListener("change", () => {
  viewPrefs.dupes = chkDupes.checked;
  saveViewPrefs();
  render();
});

// Overlay en la página real: persiste en storage.local (lo escucha content.js).
chkOverlay.addEventListener("change", () => {
  try {
    chrome.storage.local.set({ overlayEnabled: chkOverlay.checked });
  } catch {
    /* storage no disponible */
  }
});

// Filtros del overlay (tamaño mínimo e ignorar SVG), configurables aquí.
const chkOverlayIgnoreSvg = document.getElementById("chkOverlayIgnoreSvg");
const overlayMinSizeInput = document.getElementById("overlayMinSize");
if (chkOverlayIgnoreSvg) {
  chkOverlayIgnoreSvg.addEventListener("change", () => {
    try {
      chrome.storage.local.set({ overlayIgnoreSvg: chkOverlayIgnoreSvg.checked });
    } catch {
      /* storage no disponible */
    }
  });
}
if (overlayMinSizeInput) {
  overlayMinSizeInput.addEventListener("change", () => {
    try {
      const v = Math.max(0, Number(overlayMinSizeInput.value) || 0);
      overlayMinSizeInput.value = String(v);
      chrome.storage.local.set({ overlayMinSize: v });
    } catch {
      /* storage no disponible */
    }
  });
}

// --- Historial de descargas + export ---
async function recordHistory(item) {
  try {
    const data = await chrome.storage.local.get(["history"]);
    const hist = data.history || [];
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    hist.unshift({
      ts: Date.now(),
      url: item.url,
      name: itemName(item),
      sizeKB: item.sizeKB,
      page: tab ? tab.url : "",
      title: tab ? tab.title : "",
    });
    if (hist.length > 300) hist.length = 300;
    await chrome.storage.local.set({ history: hist });
  } catch {
    /* sin historial */
  }
}

async function renderHistory() {
  const q = historySearch.value.trim().toLowerCase();
  let data = {};
  try {
    data = await chrome.storage.local.get(["history"]);
  } catch {
    data = {};
  }
  const hist = (data.history || []).filter(
    (h) =>
      !q ||
      h.name.toLowerCase().includes(q) ||
      h.url.toLowerCase().includes(q) ||
      (h.page || "").toLowerCase().includes(q)
  );
  historyList.textContent = "";
  for (const h of hist) {
    const row = document.createElement("div");
    row.className = "hist-row";
    const info = document.createElement("div");
    info.className = "hist-info";
    const name = document.createElement("div");
    name.className = "hist-name";
    name.textContent = h.name;
    name.title = h.url;
    const page = document.createElement("div");
    page.className = "hist-page";
    page.textContent = `${new Date(h.ts).toLocaleTimeString()} · ${h.page || "?"}`;
    info.append(name, page);
    const re = document.createElement("button");
    re.className = "chip-btn";
    re.textContent = "Re-descargar";
    re.addEventListener("click", () => {
      dlStart({ url: h.url, filename: h.name }).catch(() => {});
      statusText.textContent = `Re-descargando ${h.name}…`;
    });
    row.append(info, re);
    historyList.appendChild(row);
  }
}

btnHistory.addEventListener("click", () => {
  historyDialog.showModal();
  renderHistory();
});

historySearch.addEventListener("input", () => {
  clearTimeout(historySearch._t);
  historySearch._t = setTimeout(renderHistory, 150);
});

btnHistoryExport.addEventListener("click", async () => {
  let data = {};
  try {
    data = await chrome.storage.local.get(["history"]);
  } catch {
    data = {};
  }
  const blob = new Blob([JSON.stringify(data.history || [], null, 2)], { type: "application/json" });
  const objUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({ url: objUrl, filename: "operant-history.json", conflictAction: "uniquify" });
  setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
});

btnExport.addEventListener("click", async () => {
  const items = sortedItems();
  const txt = items.map((it) => it.url).join("\n");
  const blob = new Blob([txt], { type: "text/plain" });
  const objUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url: objUrl,
    filename: `operant-urls-${Date.now()}.txt`,
    conflictAction: "uniquify",
  });
  setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  statusText.textContent = `${items.length} URLs exportadas.`;
});

// --- Descargas ---
// Jerarquía de descarga de vídeo (PARTE B del rediseño):
//   1. URL directa (dom / network con .mp4/.webm/.mov…) -> cola por chunks, sin yt-dlp.
//   2. Manifiesto HLS/DASH (.m3u8/.mpd) -> intentar parseo propio para ofrecer
//      calidades sin yt-dlp; si el parseo no da una URL descargable, caer a yt-dlp.
//   3. Embed de plataforma (YouTube/Vimeo…) -> yt-dlp como único camino viable.
async function downloadOne(item, indicator = null) {
  // 1. IMÁGENES Y ARCHIVOS DIRECTOS:
  // Nunca deben invocar yt-dlp, ffmpeg, DASH, HLS ni selectores de calidad de vídeo.
  if (item.type === "image" || item.type === "file") {
    statusText.textContent = `Descargando ${itemName(item)}…`;
    try {
      if (/^blob:|^data:/.test(item.url)) {
        const blob = await fetch(item.url).then((r) => r.blob());
        const objUrl = URL.createObjectURL(blob);
        await chrome.downloads.download({ url: objUrl, filename: itemName(item), conflictAction: "uniquify" });
        setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
        statusText.textContent = `Descarga completada: ${itemName(item)}`;
        recordHistory(item);
        if (indicator) indicator.success();
        return;
      }

      await chrome.downloads.download({ url: item.url, filename: itemName(item), conflictAction: "uniquify" });
      statusText.textContent = `Descarga iniciada: ${itemName(item)}`;
      recordHistory(item);
      if (indicator) indicator.success();
      return;
    } catch {
      // Fallback si la URL directa es bloqueada por CORS o anti-hotlink en el navegador:
      try {
        await downloadInPageFallback(item);
        if (indicator) indicator.success();
        return;
      } catch {
        if (item.thumb && item.thumb !== item.url) {
          try {
            await chrome.downloads.download({ url: item.thumb, filename: `thumb_${itemName(item)}`, conflictAction: "uniquify" });
            statusText.textContent = `Descargada miniatura de respaldo para ${itemName(item)}`;
            recordHistory(item);
            if (indicator) indicator.success();
            return;
          } catch {}
        }
        statusText.textContent = `No se pudo descargar: ${itemName(item)}`;
        if (indicator) indicator.error();
        return;
      }
    }
  }

  const method = item.method || (item.embed ? "embed" : item.source === "network" ? "network" : "dom");

  // Embeds y vídeos de plataforma -> yt-dlp.
  if (method === "embed") {
    if (toolInfo("yt-dlp").status === "installed") {
      downloadWithYtdl(item);
    } else {
      statusText.textContent = "Vídeo embebido: instala yt-dlp (chip inferior) para descargarlo.";
    }
    return;
  }

  // Clasificar la URL con la ÚNICA fuente de verdad (media-core.js) — la misma
  // cadena (extensión → HEAD → magic bytes → manifiesto → yt-dlp) que el SW.
  const c = await OperantMedia.classifyDownload(item.url, item.type || "video");

  // DASH con vídeo y audio SEPARADOS (Reddit/Instagram/…): el manifiesto trae
  // dos listas. Se ofrece el selector de calidades con vídeo, y al elegir se
  // remuxea con el audio de mayor bitrate vía el host (dash-merge).
  if (c.strategy === "manifest" && c.manifest?.hasSeparateAudio) {
    const vids = c.manifest.segments?.video || [];
    if (vids.length) {
      const parsed = {
        type: "dash",
        qualities: vids.map((s) => ({ id: s.id, label: s.label, url: s.url })),
        audio: c.manifest.segments?.audio || [],
        native: toolInfo("ffmpeg").status === "installed",
      };
      openManifestQuality(item, parsed);
      return;
    }
  }
  // Media playlist HLS (una sola calidad): ruta rápida 100% en navegador —
  // parseo + fetch paralelo + AES-128 (WebCrypto) + concat fMP4/TS. No hace
  // falta el host nativo (ffmpeg no aporta nada en una única calidad: el
  // fMP4 concatenado ya es un MP4 válido).
  if (c.strategy === "manifest" && c.manifest?.type === "hls") {
    await runHlsFast(item, item.url);
    return;
  }
  if (c.strategy === "manifest" && c.manifest?.type === "hls-master" && c.manifest.segments.length > 0) {
    // Master playlist: selector de variantes. Con host → ffmpeg (remux);
    // sin host → la misma ruta rápida con la variante elegida.
    const parsed = {
      type: "hls-master",
      qualities: c.manifest.segments.map((s) => ({ id: s.id, label: s.label, url: s.url })),
      native: toolInfo("ffmpeg").status === "installed",
    };
    openManifestQuality(item, parsed);
    return;
  }
  if (c.strategy === "manifest") {
    // Manifiesto no parseable (mpd raro u otro): remux con ffmpeg del host.
    const res = await chrome.runtime.sendMessage({ type: "ffmpeg-op", url: item.url, op: "hls-dash", options: { filename: itemName(item) } });
    if (!res?.ok) statusText.textContent = res?.error || "Error al procesar el manifiesto.";
    return;
  }
  if (c.strategy === "ytdl") {
    if (toolInfo("yt-dlp").status === "installed") {
      statusText.textContent = `Usando yt-dlp (${itemName(item)})…`;
      downloadWithYtdl(item);
    } else {
      statusText.textContent = "URL no descargable directamente. Instala yt-dlp para procesarla.";
    }
    return;
  }

  // strategy "direct" (o "unknown" que cae aquí): cola por chunks.
  // Defensa ANTI-INIT: un "vídeo" de <50KB suele ser un init segment de fMP4
  // (metadata sin mdat). No encolar un archivo roto.
  if (item.method === "init" || (item.sizeKB !== null && item.sizeKB !== undefined && item.sizeKB > 0 && item.sizeKB < 50)) {
    statusText.textContent = "Este elemento es metadata de stream (init segment), no un vídeo. Descarga el manifiesto/stream completo.";
    return;
  }
  statusText.textContent = `Descargando ${itemName(item)}… (cola de chunks)`;
  const pageUrl = state.tab?.url || "";
  // Anti-hotlink: si hay una página real de origen, crear la regla DNR efímera
  // que inyecta su Referer a las peticiones de la extensión (verificado: la
  // regla aplica también al fetch del panel — la cola por chunks descarga así
  // archivos grandes con protección de cabecera Referer). Se limpia
  // al terminar el job.
  let ruleId = null;
  if (/^https?:/.test(item.url) && pageUrl) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "set-dnr-referer", url: item.url, pageUrl });
      if (r?.ok) ruleId = r.ruleId;
    } catch { ruleId = null; }
  }
  const ok = await dlStart({ url: item.url, filename: itemName(item), dnrUrl: ruleId ? item.url : null, indicator });
  if (ok) {
    statusText.textContent = `En cola: ${itemName(item)}`;
    recordHistory(item);
  } else {
    try {
      if (/^blob:|^data:/.test(item.url)) {
        const blob = await fetch(item.url).then((r) => r.blob());
        const objUrl = URL.createObjectURL(blob);
        await chrome.downloads.download({ url: objUrl, filename: itemName(item), conflictAction: "uniquify" });
        setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
      } else {
        await chrome.downloads.download({ url: item.url, filename: itemName(item), conflictAction: "uniquify" });
      }
      statusText.textContent = "Descarga iniciada.";
    } catch {
      // La descarga directa falló (CORS, anti-hotlink, URL expirada…):
      // reintentar capturando el recurso DESDE la página (con cookies y
      // Referer de sesión) antes de rendirse.
      await downloadInPageFallback(item);
    }
  }
}

// Fallback anti-hotlink en 2 niveles:
//   Nivel A — el SW hace el fetch (sin CORS con <all_urls>) con el Referer de
//     la página inyectado por declarativeNetRequest. Resuelve servidores que NO mandan
//     Access-Control-Allow-Origin donde el content script muere
//     por CORS. El blob vuelve al panel vía download-blob -> chrome.downloads.
//   Nivel B — captura DESDE la página (cookies + Referer reales): para CDNs que
//     SÍ mandan ACAO y exigen la sesión de la página.
async function downloadInPageFallback(item) {
  try {
    const res = await withTimeout(
      chrome.runtime.sendMessage({
        type: "sw-fetch-blob",
        url: item.url,
        tabId: state.tabId,
        pageUrl: state.tab?.url || "",
        filename: itemName(item),
      }),
      120000
    );
    if (res?.ok) {
      statusText.textContent = "Descargado vía el navegador (con Referer de la página).";
      recordHistory(item);
      return;
    }
    if (!/^http/.test(item.url)) {
      statusText.textContent = res?.error ? `No se pudo descargar: ${res.error}` : "No se pudo descargar.";
      return;
    }
    // Nivel B: el SW no pudo (cookies HttpOnly / DNR no aplica) — capturar desde la página.
    statusText.textContent = `Descarga directa falló — capturando ${itemName(item)} desde la página…`;
    const res2 = await withTimeout(
      chrome.runtime.sendMessage({
        type: "capture-in-page",
        url: item.url,
        tabId: state.tabId,
        filename: itemName(item),
      }),
      120000
    );
    if (res2?.ok) {
      statusText.textContent = "Descargado desde la página (con sesión).";
      recordHistory(item);
    } else {
      statusText.textContent = res2?.error ? `No se pudo descargar: ${res2.error}` : "No se pudo descargar desde la página.";
    }
  } catch (e) {
    statusText.textContent = `No se pudo capturar: ${String(e.message || e)}`;
  }
}

// --- Ruta rápida HLS (100% en navegador, sin host nativo) ---
// Ejecuta shared/hls-fast.js sobre la cola dlJobs existente: progreso por
// segmentos, anti-hotlink con reglas DNR POR HOST (una por dominio de CDN, no
// por segmento: cientos de reglas reventarían el límite), entrega como .mp4
// (fMP4) o .ts (MPEG-TS) vía el createObjectURL del panel.
// Pausable vía AbortController (downloadHls ya lo soporta); reanudar = reinicio.
function runHlsFast(item, playlistUrl) {
  const job = {
    id: dlNextId++,
    url: playlistUrl,
    name: itemName(item).replace(/\.(m3u8|mpd)$/i, ""),
    status: "queued",
    received: 0,
    total: 0,
    error: null,
    dnrUrl: null,
    indicator: null,
    kind: "hls",
    ac: new AbortController(),
    paused: false,
    failed: false,
    chunks: null,
    count: 0,
    nextChunk: 0,
    item,
    hostsTouched: new Set(),
  };
  dlJobs.set(job.id, job);
  dlBroadcast();
  dlPump();
}

async function dlRunHlsJob(job) {
  const pageUrl = state.tab?.url || "";
  const hostsTouched = job.hostsTouched;
  try {
    const result = await HLSFast.downloadHls({
      url: job.url,
      concurrency: 6,
      signal: job.ac.signal,
      beforeFetch: async (segUrl) => {
        try {
          const host = new URL(segUrl).hostname;
          if (pageUrl && /^https?:/.test(segUrl) && !hostsTouched.has(host)) {
            hostsTouched.add(host);
            const r = await chrome.runtime.sendMessage({ type: "set-dnr-referer-host", host, pageUrl });
            if (!r?.ok) hostsTouched.delete(host); // sin regla: no limpiar lo ajeno
          }
        } catch {
          /* URL relativa rara: la regla global de la página ya cubre lo típico */
        }
      },
      onProgress: (a, b) => {
        // VOD: (done, total). Live: objeto {bytes, segments, durationSec, ...}.
        if (a && typeof a === "object" && a.live) {
          job.live = true;
          job.startedAt = job.startedAt || Date.now();
          job.received = a.bytes;
          job.total = 0;
          job.segmentsLive = a.segments;
          job.durationLive = a.durationSec;
        } else {
          job.received = a;
          job.total = b;
        }
        dlBroadcast();
      },
    });
    job.status = "assembling";
    dlBroadcast();
    const ext = result.kind === "ts" ? ".ts" : ".mp4";
    const name = /\.\w+$/.test(job.name) ? job.name.replace(/\.\w+$/, ext) : job.name + ext;
    await dlDeliver(result.blob, { ...job, name });
    job.status = "done";
    dlReportIndicator(job, "done");
    dlBroadcast();
    const mb = (result.bytes / 1048576).toFixed(1);
    statusText.textContent = `Descargado por ruta rápida: ${result.segments} segmentos, ${mb} MB${result.encrypted ? " (AES-128 descifrado)" : ""}.`;
    recordHistory(job.item);
  } catch (e) {
    if (job.paused && !job.live) {
      // Sin limpiar las reglas DNR por host: la reanudación las reutiliza.
      job.status = "paused";
      dlBroadcast();
      return;
    }
    if (job.paused && job.live) {
      // Parada de una grabación live: downloadHlsLive ya finaliza y entrega;
      // aquí solo llega un error simultáneo — tratar como cierre limpio.
      job.status = "done";
      dlBroadcast();
      return;
    }
    job.status = "error";
    job.error = String(e?.message || e);
    dlReportIndicator(job, "error");
    statusText.textContent = `Ruta rápida falló: ${job.error}`;
  }
  dlBroadcast();
  for (const host of hostsTouched) {
    chrome.runtime.sendMessage({ type: "clear-dnr-referer-host", host }).catch(() => {});
  }
  job.hostsTouched = new Set();
  setTimeout(() => {
    if (dlJobs.has(job.id)) {
      dlJobs.delete(job.id);
      dlBroadcast();
    }
  }, 60000);
}

// --- Selector de calidades para manifiestos (parseo propio, sin yt-dlp) ---
let manifestQualityItem = null;
let manifestQualityData = null;

// Lista de URLs a descargar para un track DASH: init + media segments.
function buildSegList(q) {
  if (q && Array.isArray(q.segments) && q.segments.length) {
    const list = [];
    if (q.initUrl) list.push(q.initUrl);
    for (const s of q.segments) list.push(s);
    return list;
  }
  return q && q.url ? [q.url] : [];
}

function openManifestQuality(item, parsed) {
  manifestQualityItem = item;
  manifestQualityData = parsed;
  qualityItem = null;
  qualityDialog.showModal();
  qualityList.textContent = "";
  const hasAudio = !!(parsed.audio && parsed.audio.length);
  const native = parsed.native !== false; // por defecto se asume host disponible
  qualityStatus.textContent = hasAudio
    ? native
      ? "Calidades del manifiesto (DASH). Elige el vídeo: se descargará junto con el audio de mayor calidad y se unirá con ffmpeg."
      : "DASH con audio separado y host nativo no instalado: se descargará solo el vídeo (sin audio) por la ruta rápida del navegador."
    : native
      ? "Calidades del manifiesto (parseadas sin yt-dlp). Elige una para descargarla con el host nativo (ffmpeg)."
      : "Calidades del manifiesto. El host nativo no está instalado: se usará la ruta rápida del navegador (sin ffmpeg).";
  qualityStatus.className = "proc-status";
  qualityRun.disabled = true;
  for (const q of parsed.qualities) {
    const label = document.createElement("label");
    label.className = "fmt-row";
    const rb = document.createElement("input");
    rb.type = "radio";
    rb.name = "mfmt";
    rb.value = q.id;
    rb.checked = true;
    const span = document.createElement("span");
    span.textContent = `${q.label} — ${q.url}`;
    label.append(rb, span);
    label.addEventListener("click", () => {
      qualityRun.disabled = false;
    });
    qualityList.appendChild(label);
  }
  qualityRun.disabled = false;
}

// --- Cola de descargas por chunks (vive en el panel: el SW no tiene createObjectURL) ---
const DL_CHUNK = 4 * 1024 * 1024;
const DL_MAX_IN_FLIGHT = 8;
const dlJobs = new Map();
let dlNextId = 1;
let dlInFlight = 0;
let dlConcurrencyValue = 3;

async function dlStart({ url, filename, dnrUrl = null, indicator = null }) {
  const job = {
    id: dlNextId++, url, name: filename || "descarga", status: "queued",
    received: 0, total: 0, error: null, dnrUrl, indicator,
    kind: "chunk", ac: new AbortController(), paused: false, failed: false,
    chunks: null, count: 0, nextChunk: 0, item: null, hostsTouched: null,
  };
  dlJobs.set(job.id, job);
  dlBroadcast();
  dlPump();
  return true;
}

// Pausa: aborta el fetch en curso; el catch del runner cierra el job como
// "paused" conservando chunks, cursor y reglas DNR para la reanudación.
function dlPause(job) {
  if (job.status !== "queued" && job.status !== "downloading") return;
  job.paused = true;
  if (job.status === "queued") {
    job.status = "paused";
    dlBroadcast();
  } else {
    job.ac?.abort();
  }
}

// Reanudar (o reintentar un error): los chunks ya recibidos no se repiten.
// En single/hls no hay estado de chunks reutilizable → arranque completo.
function dlResume(job) {
  if (job.status !== "paused" && job.status !== "error") return;
  job.paused = false;
  job.failed = false;
  job.error = null;
  job.ac = new AbortController();
  if (job.kind === "chunk" && job.chunks) {
    job.received = 0;
    let firstHole = job.count;
    for (let i = 0; i < job.count; i++) {
      if (job.chunks[i]) job.received += job.chunks[i].byteLength;
      else if (firstHole === job.count) firstHole = i;
    }
    job.nextChunk = firstHole;
  } else {
    job.chunks = null;
    job.received = 0;
  }
  if (job.indicator && job.total > 0) {
    job.indicator.setProgress(job.received / job.total);
  }
  job.status = "queued";
  dlBroadcast();
  dlPump();
}

// Guarda el prefijo contiguo descargado (desde el byte 0 hasta el primer hueco).
async function dlSavePartial(job) {
  if (job.kind !== "chunk" || !job.chunks) return;
  let contig = 0;
  while (contig < job.count && job.chunks[contig]) contig++;
  if (contig === 0) return;
  const m = job.name.match(/^(.*?)(\.\w+)?$/);
  const partialName = `${m[1]}.parcial${m[2] || ""}`;
  const blob = new Blob(job.chunks.slice(0, contig), { type: "application/octet-stream" });
  await dlDeliver(blob, { ...job, name: partialName });
}

// Limpia la regla DNR efímera del job (si se creó) al terminar.
function dlClearDnr(job) {
  if (job.dnrUrl) {
    chrome.runtime.sendMessage({ type: "clear-dnr-referer", url: job.dnrUrl }).catch(() => {});
    job.dnrUrl = null;
  }
}

// Reporta el fin del job al indicador de motion design (check o error).
function dlReportIndicator(job, status) {
  if (!job.indicator) return;
  if (status === "error") job.indicator.error();
  else job.indicator.success();
}

function dlBroadcast() {
  renderDlJobs();
  const active = [...dlJobs.values()].filter((j) => j.status !== "done" && j.status !== "error" && j.status !== "paused").length;
  btnDl.hidden = dlJobs.size === 0;
  btnDl.textContent = `Descargas (${active})`;
}

function dlSummary() {
  return [...dlJobs.values()].map((j) => ({
    id: j.id, name: j.name, url: j.url, status: j.status, kind: j.kind,
    received: j.received, total: j.total, error: j.error || null,
    live: !!j.live, segmentsLive: j.segmentsLive || 0, startedAt: j.startedAt || 0,
    progress: j.total > 0 ? Math.min(100, Math.round((j.received / j.total) * 100)) : 0,
  }));
}

async function dlPump() {
  const active = [...dlJobs.values()].filter((j) => j.status === "downloading" || j.status === "assembling").length;
  if (active >= dlConcurrencyValue) return;
  const next = [...dlJobs.values()].find((j) => j.status === "queued");
  if (next) {
    next.status = "downloading";
    dlBroadcast();
    dlRunJob(next).then(() => dlPump());
  }
}

async function dlRunJob(job) {
  if (job.kind === "hls") return dlRunHlsJob(job);
  const signal = job.ac.signal;
  try {
    if (!job.chunks) {
      const probe = await fetch(job.url, { method: "HEAD", cache: "no-store", signal });
      const acceptRanges = (probe.headers.get("accept-ranges") || "").toLowerCase() === "bytes";
      const total = Number(probe.headers.get("content-length") || 0);

      if (!acceptRanges || total <= DL_CHUNK || /^blob:|^data:/.test(job.url)) {
        // Ruta single-shot: sin estado de chunks, la pausa aborta y la
        // reanudación rearranca desde cero.
        job.kind = "single";
        job.total = total || 0;
        const res = await fetch(job.url, { cache: "no-store", signal });
        const blob = await res.blob();
        job.received = blob.size;
        job.total = blob.size;
        dlBroadcast();
        await dlDeliver(blob, job);
        job.status = "done";
        dlClearDnr(job);
        dlReportIndicator(job, "done");
        dlBroadcast();
        return;
      }

      job.total = total;
      // Progreso real: si el total se conoce, el indicador muestra el % real.
      if (job.indicator) {
        job.indicator.setProgress(0);
      }
      job.count = Math.ceil(total / DL_CHUNK);
      job.chunks = new Array(job.count);
      job.nextChunk = 0;
      dlBroadcast();
    }

    while (job.nextChunk < job.count && !job.failed) {
      if (job.paused) {
        job.status = "paused";
        dlBroadcast();
        return; // sin limpiar DNR: la reanudación reutiliza la regla efímera
      }
      if (dlInFlight >= DL_MAX_IN_FLIGHT) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      // Reanudación: saltar los chunks ya recibidos.
      if (job.chunks[job.nextChunk]) {
        job.nextChunk++;
        continue;
      }
      // Esperar a que el chunk termine antes de lanzar el siguiente: sin
      // esto, dlInFlight no se respeta y se lanzan TODOS los chunks a la vez
      // (75 chunks × 4MB = 300MB en vuelo -> "Failed to fetch").
      await dlFetchChunk(job);
    }
    if (job.paused) {
      job.status = "paused";
      dlBroadcast();
      return;
    }
    if (job.failed) {
      job.status = "error";
      dlClearDnr(job);
      dlReportIndicator(job, "error");
      dlBroadcast();
      return;
    }
    await dlFinish(job, job.chunks);
  } catch (err) {
    if (job.paused) {
      job.status = "paused";
      dlBroadcast();
      return;
    }
    job.status = "error";
    job.error = String(err.message || err);
    dlClearDnr(job); // regla efímera: limpiar al terminar (aunque falle)
    dlReportIndicator(job, "error");
    dlBroadcast();
  }
}

async function dlFetchChunk(job) {
  const index = job.nextChunk++;
  const start = index * DL_CHUNK;
  const end = Math.min(job.total - 1, start + DL_CHUNK - 1);
  dlInFlight++;
  try {
    const res = await fetch(job.url, { headers: { Range: `bytes=${start}-${end}` }, cache: "no-store", signal: job.ac.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    job.chunks[index] = buf;
    job.received += buf.byteLength;
    // Animar el anillo con el % real (transition 200ms linear en el CSS).
    if (job.indicator && job.total > 0) {
      job.indicator.setProgress(job.received / job.total);
    }
    dlBroadcast();
  } catch (err) {
    // Pausa o fallo: este rango se repite al reanudar.
    job.nextChunk = index;
    if (!job.paused) {
      job.failed = true;
      job.error = String(err.message || err);
    }
  } finally {
    dlInFlight--;
  }
}

async function dlFinish(job, chunks) {
  job.status = "assembling";
  dlBroadcast();
  try {
    const blob = new Blob(chunks, { type: "application/octet-stream" });
    await dlDeliver(blob, job);
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = String(err.message || err);
  }
  dlClearDnr(job); // regla efímera: limpiar al terminar
  dlReportIndicator(job, job.status === "error" ? "error" : "done");
  dlBroadcast();
  setTimeout(() => {
    if (dlJobs.has(job.id)) {
      dlJobs.delete(job.id);
      dlBroadcast();
    }
  }, 60000);
}

async function dlDeliver(blob, job) {
  const objUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url: objUrl, filename: job.name, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  }
}

// Entrega de un blob capturado por el SW (anti-hotlink) al gestor de descargas.
// El panel tiene URL.createObjectURL (el SW de MV3 no) y chrome.downloads.
async function dlDeliverBlob(blob, name) {
  const objUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url: objUrl, filename: /\.\w+$/.test(name) ? name : `${name}.mp4`, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  }
}

// Construye el zip con exactamente las URLs dadas (selección si la hay,
// si no, todo lo visible). Extraído para poder verificar el contenido en
// pruebas (hook __operant.zipCount).
async function buildZipFromUrls(urls) {
  const items = urls.map((u) => state.items.find((it) => it.url === u)).filter(Boolean);
  const zip = new JSZip();
  const used = new Set();
  let okCount = 0;
  let failCount = 0;

  for (const item of items) {
    try {
      let blob = null;
      try {
        blob = await fetch(item.url).then((r) => {
          if (!r.ok) throw new Error(r.status);
          return r.blob();
        });
      } catch {
        if (item.thumb) {
          blob = await fetch(item.thumb).then((r) => {
            if (!r.ok) throw new Error(r.status);
            return r.blob();
          }).catch(() => null);
        }
      }
      if (!blob) throw new Error("fetch-failed");
      let name = itemName(item);
      if (!/\.\w+$/.test(name)) name += item.ext ? `.${item.ext}` : "";
      let unique = name;
      let n = 1;
      while (used.has(unique)) unique = name.replace(/(\.\w+)?$/, `_${n++}$1`);
      used.add(unique);
      zip.file(unique, blob);
      okCount++;
    } catch {
      failCount++;
    }
  }

  return {
    okCount,
    failCount,
    blob: okCount > 0 ? await zip.generateAsync({ type: "blob" }) : null,
  };
}

async function downloadZip() {
  const urls = state.selected.size > 0 ? [...state.selected] : lastFiltered.map((it) => it.url);
  const total = urls.length;
  if (total === 0) return;
  statusText.textContent = `Comprimiendo ${total} archivos…`;
  btnZip.disabled = true;

  const { okCount, failCount, blob } = await buildZipFromUrls(urls);

  if (!blob) {
    statusText.textContent = "Ningún archivo pudo descargarse (CORS).";
    btnZip.disabled = false;
    return;
  }

  try {
    const objUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: objUrl, filename: "operant.zip", conflictAction: "uniquify" });
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    statusText.textContent = `Zip creado (${okCount} ok${failCount ? `, ${failCount} fallidos` : ""}).`;
  } catch {
    statusText.textContent = "Error al generar el zip.";
  }
  btnZip.disabled = false;
}

async function downloadWithYtdl(item) {
  statusText.textContent = `Consultando calidades de ${itemName(item)}…`;
  const res = await chrome.runtime.sendMessage({ type: "ytdl-list-formats", url: item.url });
  if (!res?.ok) {
    statusText.textContent = res?.error || "Error al consultar calidades.";
    return;
  }
  qualityItem = item;
  qualityDialog.showModal();
  qualityList.textContent = "";
  qualityStatus.textContent = "Cargando calidades…";
  qualityStatus.className = "proc-status busy";
  qualityRun.disabled = true;
}

// --- Selector de calidad (paridad FetchV) ---
let qualityItem = null;
const qualityDialog = document.getElementById("qualityDialog");
const qualityList = document.getElementById("qualityList");
const qualityStatus = document.getElementById("qualityStatus");
const qualityRun = document.getElementById("qualityRun");
let qualityFormats = [];

function renderFormats(formats) {
  qualityList.textContent = "";
  qualityFormats = formats;
  if (!formats.length) {
    qualityStatus.textContent = "yt-dlp no reportó formatos; se usará la máxima calidad por defecto.";
    qualityStatus.className = "proc-status err";
    qualityRun.disabled = false;
    return;
  }
  const best = document.createElement("label");
  best.className = "fmt-row";
  const rb = document.createElement("input");
  rb.type = "radio";
  rb.name = "fmt";
  rb.value = "";
  rb.checked = true;
  const span = document.createElement("span");
  span.textContent = "Máxima calidad (bestvideo*+bestaudio)";
  best.append(rb, span);
  qualityList.appendChild(best);
  for (const f of formats) {
    const label = document.createElement("label");
    label.className = "fmt-row";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "fmt";
    radio.value = f.id;
    const s = document.createElement("span");
    s.textContent = `#${f.id} · ${f.ext || "?"} · ${f.note.slice(0, 90)}`;
    label.append(radio, s);
    qualityList.appendChild(label);
  }
  qualityStatus.textContent = `${formats.length} formatos disponibles.`;
  qualityStatus.className = "proc-status";
  qualityRun.disabled = false;
}

qualityRun.addEventListener("click", async () => {
  // Modo manifiesto (parseo propio, nivel 2): procesar con ffmpeg del host.
  if (manifestQualityItem) {
    const sel = qualityList.querySelector('input[name="mfmt"]:checked');
    const q = manifestQualityData.qualities.find((x) => x.id === sel?.value) || manifestQualityData.qualities[0];
    const item = manifestQualityItem;
    const audio = manifestQualityData.audio || null;
    const sourceUrl = manifestQualityData.sourceUrl || item.url;
    const native = manifestQualityData.native !== false;
    manifestQualityItem = null;
    manifestQualityData = null;
    qualityDialog.close();
    if (audio && audio.length) {
      // DASH con audio separado: CON host → remux ffmpeg (vídeo elegido +
      // audio de mayor bitrate). SIN host → ruta rápida solo vídeo (el
      // navegador no puede muxear pistas separadas sin ffmpeg).
      if (native) {
        const bestAudio = audio.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
        statusText.textContent = `DASH: descargando vídeo (${q.label}) + audio y uniéndolos…`;
        const res = await chrome.runtime.sendMessage({
          type: "ffmpeg-op",
          url: q.url,
          op: "dash-merge",
          options: {
            videoUrl: q.url,
            audioUrl: bestAudio.url,
            filename: itemName(item),
            videoSegments: buildSegList(q),
            audioSegments: buildSegList(bestAudio),
          },
        });
        if (!res?.ok) statusText.textContent = res?.error || "Error al unir vídeo+audio (DASH).";
      } else {
        statusText.textContent = "Sin host nativo: descargando solo el vídeo (sin audio) por la ruta rápida…";
        await runHlsFast(item, q.url);
      }
      return;
    }
    if (native) {
      statusText.textContent = `Manifiesto: descargando con ffmpeg (${q.label})…`;
      const res = await chrome.runtime.sendMessage({
        type: "ffmpeg-op",
        url: q.url,
        op: "hls-dash",
        options: { sourceUrl, filename: itemName(item) },
      });
      if (!res?.ok) statusText.textContent = res?.error || "Error al procesar el manifiesto.";
    } else {
      statusText.textContent = `Ruta rápida del navegador (${q.label}, sin host nativo)…`;
      await runHlsFast(item, q.url);
    }
    return;
  }

  // Modo yt-dlp (nivel 3): selector de formatos clásico.
  const selected = qualityList.querySelector('input[name="fmt"]:checked');
  const fmtId = selected ? selected.value : "";
  qualityDialog.close();
  statusText.textContent = `yt-dlp: descargando ${itemName(qualityItem)}${fmtId ? ` (formato ${fmtId})` : " (máx. calidad)"}…`;
  const res = await chrome.runtime.sendMessage({
    type: "ytdl-download",
    url: qualityItem.url,
    filename: itemName(qualityItem),
    format: fmtId,
  });
  if (!res?.ok) statusText.textContent = res?.error || "Error al lanzar yt-dlp.";
});

// --- Postprocesado con ffmpeg nativo (vía host, sin WASM) ---
let procUrl = null;

const FFMPEG_OPS_NEEDING_QUALITY = new Set(["compress"]);

function populateProcSource() {
  procSource.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Elegir un medio de la página…";
  procSource.appendChild(none);
  const candidates = state.items.filter((it) => it.type === "image" || it.type === "video" || it.type === "audio");
  for (const it of candidates) {
    const opt = document.createElement("option");
    opt.value = it.url;
    opt.textContent = `${itemName(it)} (${it.ext})`;
    procSource.appendChild(opt);
  }
  procUrl = "";
  procSource.value = "";
}

procOp.addEventListener("change", () => {
  procQualityField.hidden = !FFMPEG_OPS_NEEDING_QUALITY.has(procOp.value);
});

async function runProcessor() {
  if (!procUrl) {
    procStatus.textContent = "Elige un medio de la página primero.";
    procStatus.className = "proc-status err";
    return;
  }
  procRun.disabled = true;
  procBar.value = 0;
  procStatus.textContent = "Enviando al host nativo…";
  procStatus.className = "proc-status busy";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "ffmpeg-op",
      url: procUrl,
      op: procOp.value,
      options: { crf: Number(procQuality.value) || 28 },
    });
    if (!res?.ok) throw new Error(res?.error || "error");
    procStatus.textContent = "Descargando + procesando en tu PC…";
  } catch (err) {
    procStatus.textContent = `Error: ${err.message}`;
    procStatus.className = "proc-status err";
    procRun.disabled = false;
  }
}

btnProcess.addEventListener("click", () => {
  populateProcSource();
  procQualityField.hidden = !FFMPEG_OPS_NEEDING_QUALITY.has(procOp.value);
  procStatus.textContent = "El procesado ocurre en tu PC con el ffmpeg del host nativo (rápido, todos los codecs). El resultado se guarda en ~/Downloads/Operant/.";
  procStatus.className = "proc-status";
  procBar.value = 0;
  procDialog.showModal();
});

procSource.addEventListener("change", () => {
  procUrl = procSource.value;
});

procRun.addEventListener("click", runProcessor);

// --- Diálogo de Descargas (cola local por chunks) ---
async function refreshDlDialog() {
  dlConcurrency.value = dlConcurrencyValue;
  renderDlJobs();
}

function dlRowBtn(label, fn) {
  const b = document.createElement("button");
  b.className = "chip-btn";
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

function renderDlJobs() {
  if (!dlDialog.open) return;
  const jobs = dlSummary();
  dlJobsEl.textContent = "";
  let sumReceived = 0;
  let sumTotal = 0;
  let done = 0;
  let failed = 0;
  for (const j of jobs) {
    sumReceived += j.received || 0;
    sumTotal += j.total || 0;
    if (j.status === "done") done++;
    if (j.status === "error") failed++;

    const job = dlJobs.get(j.id);
    const row = document.createElement("div");
    row.className = "dl-job";
    const head = document.createElement("div");
    head.className = "dl-job-head";
    const name = document.createElement("span");
    name.className = "dl-job-name";
    name.textContent = j.name;
    name.title = j.name;
    const st = document.createElement("span");
    st.className = "dl-job-status" + (j.status === "done" ? " done" : j.status === "error" ? " error" : j.status === "paused" ? " paused" : "");
    const size = j.total ? `${formatBytes(j.received)} / ${formatBytes(j.total)}` : formatBytes(j.received);
    if (j.live && (j.status === "downloading" || j.status === "queued")) {
      const elapsed = j.startedAt ? Math.max(0, Math.round((Date.now() - j.startedAt) / 1000)) : 0;
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      st.textContent = `grabando · ${formatBytes(j.received)} · ${j.segmentsLive} seg · ${mm}:${ss}`;
    } else {
      st.textContent = j.status === "done" ? "✓"
        : j.status === "error" ? `error: ${j.error || "?"}`
        : j.status === "paused" ? `en pausa · ${size} · ${j.progress}%`
        : `${size} · ${j.progress}%`;
    }
    head.append(name, st);
    row.appendChild(head);
    const bar = document.createElement("progress");
    bar.value = j.progress || 0;
    bar.max = 100;
    if (j.live && (j.status === "downloading" || j.status === "queued")) {
      bar.hidden = true; // sin total conocido: el texto lleva el progreso
    }
    row.appendChild(bar);
    const actions = document.createElement("div");
    actions.className = "dl-job-actions";
    if (j.live && (j.status === "downloading" || j.status === "queued")) {
      actions.appendChild(dlRowBtn("Parar y guardar", () => { dlPause(job); refreshDlDialog(); }));
    } else if (j.status === "downloading" || j.status === "queued") {
      actions.appendChild(dlRowBtn("Pausar", () => { dlPause(job); refreshDlDialog(); }));
    }
    if (j.status === "paused") {
      actions.appendChild(dlRowBtn("Reanudar", () => { dlResume(job); refreshDlDialog(); }));
      if (j.kind === "chunk" && job?.chunks?.some(Boolean)) {
        actions.appendChild(dlRowBtn("Guardar parcial", () => dlSavePartial(job).catch(() => {})));
      }
    }
    if (j.status === "error" && j.url) {
      actions.appendChild(dlRowBtn("Reintentar", () => {
        // Con estado de chunks reanuda por rangos; si no, rearranca.
        if (job) dlResume(job);
        else dlStart({ url: j.url, filename: j.name });
        refreshDlDialog();
      }));
    }
    if (actions.childElementCount > 0) row.appendChild(actions);
    dlJobsEl.appendChild(row);
  }
  const pct = sumTotal > 0 ? Math.round((sumReceived / sumTotal) * 100) : 0;
  dlTotalBar.value = pct;
  dlTotalText.textContent = `${done} completadas · ${failed} con error · agregado ${pct}%`;
}

btnDl.addEventListener("click", async () => {
  dlDialog.showModal();
  await refreshDlDialog();
  renderDlJobs();
});

dlConcurrency.addEventListener("change", async () => {
  dlConcurrencyValue = Math.max(1, Math.min(8, Number(dlConcurrency.value) || 3));
  dlConcurrency.value = dlConcurrencyValue;
  await chrome.storage.local.set({ dlConcurrency: dlConcurrencyValue });
  refreshDlDialog();
});

// --- Comunicación con el service worker ---
async function requestState() {
  loading = true;
  render();
  statusText.textContent = "Escaneando…";
  let res = null;
  try {
    res = await withTimeout(chrome.runtime.sendMessage({ type: "get-state", tabId: state.tabId }), 8000);
  } catch {
    res = null;
  }
  loading = false;
  if (res && Array.isArray(res.items)) {
    setItems(res.items);
    await applyPersistedSelection();
    state.reachable = !!res.reachable;
    if (connDot) connDot.classList.toggle("ok", !!res.reachable);
    statusText.textContent = res.reachable
      ? `${state.items.length} medios detectados`
      : "";
  } else {
    // El SW no respondió (MV3 dormido, recarga de extensión…). NO se vacían
    // los items: conservar el último estado conocido evita el "Sin resultados"
    // falso con contador lleno (bug real v0.4: vaciado prematuro en onUpdated
    // + wipe en este else desincronizaban grid y contador).
    if (state.items.length > 0) {
      statusText.textContent = `Fondo no disponible — mostrando ${state.items.length} medios del último escaneo`;
    } else {
      statusText.textContent = "No se pudo contactar con el servicio de fondo. Recarga la extensión.";
    }
  }
  render();
}

function populateExtOptions() {
  const exts = new Set(state.items.map((it) => it.ext).filter(Boolean));
  fExt.textContent = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Tipo: todo";
  fExt.appendChild(all);
  for (const e of [...exts].sort()) {
    const opt = document.createElement("option");
    opt.value = e;
    opt.textContent = e;
    fExt.appendChild(opt);
  }
  fExt.value = viewPrefs.fExt || "";
  if (fExt.value && !exts.has(fExt.value)) viewPrefs.fExt = "";

  // Datalist de dominios conocidos para el filtro de dominio.
  const doms = new Set(state.items.map((it) => it.domain).filter(Boolean));
  domainList.textContent = "";
  for (const d of doms) {
    const opt = document.createElement("option");
    opt.value = d;
    domainList.appendChild(opt);
  }
}

async function refreshNativeStatus() {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "native-healthcheck" });
  } catch {
    res = null;
  }
  if (res?.status) state.native = res.status;
  renderNativeChip();
  renderTools();
}

function renderNativeChip() {
  if (!state.native.installed) {
    nativeChip.hidden = false;
    nativeChip.innerHTML = `<span class="chip-status-dot off"></span>Companion: inactivo`;
    nativeChip.classList.add("off");
    return;
  }
  nativeChip.hidden = false;
  nativeChip.classList.remove("off");
  const yt = toolInfo("yt-dlp");
  const ff = toolInfo("ffmpeg");
  const ytOk = yt.status === "installed" || yt.legacy;
  const ffOk = ff.status === "installed" || ff.legacy;
  nativeChip.innerHTML = `<span class="chip-status-dot on"></span>yt-dlp ${ytOk ? (yt.version || "✓") : "no"} · ffmpeg ${ffOk ? "✓" : "no"}`;
  btnYtdl.hidden = yt.status !== "installed";
}

// --- Dialogo de Herramientas (auto-gestion de yt-dlp / ffmpeg) ---
const toolsDialog = document.getElementById("toolsDialog");
const toolsPath = document.getElementById("toolsPath");

const TOOL_LABELS = { "yt-dlp": "yt-dlp", ffmpeg: "ffmpeg" };

async function openToolsDialog() {
  toolsDialog.showModal();
  for (const tool of ["yt-dlp", "ffmpeg"]) setToolProgress(tool, null);
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "native-tools-status" });
  } catch {
    res = null;
  }
  if (res?.status) state.native = res.status;
  renderTools();
  refreshNativeStatus();
}

function setToolProgress(tool, value) {
  const bar = document.getElementById(`bar-${tool}`);
  const phase = document.getElementById(`phase-${tool}`);
  if (value === null || value === undefined) {
    bar.hidden = true;
    phase.textContent = "";
    return;
  }
  bar.hidden = false;
  bar.value = value;
}

function renderTools() {
  if (!toolsDialog.open) return;
  const banner = document.getElementById("companionBanner");
  const title = document.getElementById("companionStatusTitle");
  const desc = document.getElementById("companionStatusDesc");
  const pulse = document.getElementById("companionPulse");

  const btnReconnect = document.getElementById("btnReconnectHost");

  if (!state.native.installed) {
    if (banner) banner.className = "companion-banner disconnected";
    if (title) title.textContent = "Operant Companion: No detectado";
    if (desc) desc.textContent = "Haz doble clic en operant-host.exe (carpeta native-host) para activar yt-dlp y ffmpeg sin consola.";
    if (pulse) pulse.className = "companion-pulse off";
    if (btnReconnect) btnReconnect.hidden = false;
  } else {
    if (banner) banner.className = "companion-banner connected";
    if (title) title.textContent = "Operant Companion: Conectado (Rust)";
    if (desc) desc.textContent = "yt-dlp y ffmpeg vinculados correctamente a través de Native Messaging.";
    if (pulse) pulse.className = "companion-pulse on";
    if (btnReconnect) btnReconnect.hidden = true;
  }

  for (const tool of ["yt-dlp", "ffmpeg"]) {
    const info = toolInfo(tool);
    const stateEl = document.getElementById(`state-${tool}`);
    const btn = document.getElementById(`btn-${tool}`);
    const uninstBtn = document.getElementById(`btn-uninstall-${tool}`);
    const note = document.getElementById(`note-${tool}`);
    const phase = document.getElementById(`phase-${tool}`);

    if (uninstBtn) uninstBtn.hidden = true;

    if (!state.native.installed) {
      stateEl.textContent = "host no instalado";
      stateEl.className = "tool-state err";
      btn.hidden = true;
      note.textContent = "Ejecuta operant-host.exe con doble clic (una sola vez).";
      continue;
    }
    if (info.unknown && !info.installed && !info.version) {
      stateEl.textContent = "no detectado";
      stateEl.className = "tool-state warn";
      btn.hidden = false;
      btn.textContent = "Instalar";
      btn.disabled = false;
      note.textContent = "Instalar en ~/Operant/bin/";
      continue;
    }
    if (info.status !== "installed") {
      stateEl.textContent = "no instalado";
      stateEl.className = "tool-state err";
      btn.hidden = false;
      btn.textContent = "Instalar";
      btn.disabled = false;
      note.textContent = info.latestVersion ? `última versión: ${info.latestVersion}` : "Instalar en ~/Operant/bin/";
      continue;
    }

    const isApp = info.source === "app";
    stateEl.textContent = `v${info.version || "?"} (${isApp ? "Operant" : "sistema"})`;
    stateEl.className = "tool-state ok";

    // Si fue instalado por Operant en ~/Operant/bin/, mostrar opción de desinstalar.
    // Si ya estaba en el PC del usuario (sistema/PATH), NO desinstalar y señalarlo con claridad.
    if (isApp) {
      if (uninstBtn) {
        uninstBtn.hidden = false;
        uninstBtn.disabled = false;
      }
    }

    if (info.updateAvailable && info.latestVersion) {
      stateEl.textContent = `v${info.version} → ${info.latestVersion} disponible`;
      stateEl.className = "tool-state warn";
      btn.hidden = false;
      btn.textContent = "Actualizar";
      btn.disabled = false;
      note.textContent = isApp ? "Instalado por Operant (~/Operant/bin/)" : "✓ Detectado en tu sistema (PATH)";
    } else if (info.updateCheckError) {
      stateEl.textContent = `v${info.version} · no se pudo comprobar actualizaciones`;
      stateEl.className = "tool-state warn";
      btn.hidden = true;
      note.textContent = isApp ? "Instalado por Operant (~/Operant/bin/)" : "✓ Detectado en tu sistema (PATH)";
    } else if (isApp && tool === "ffmpeg") {
      btn.hidden = false;
      btn.textContent = "Reinstalar";
      btn.disabled = false;
      note.textContent = "Instalado por Operant (~/Operant/bin/)";
    } else {
      btn.hidden = true;
      note.textContent = isApp ? "Instalado por Operant (~/Operant/bin/)" : "✓ Detectado en tu sistema (PATH)";
    }
    if (phase.textContent && !phase.textContent.includes("desinstalado")) setToolProgress(tool, 0);
  }
}

async function toolAction(tool, action) {
  const btn = document.getElementById(`btn-${tool}`);
  const uninstBtn = document.getElementById(`btn-uninstall-${tool}`);
  if (btn) btn.disabled = true;
  if (uninstBtn) uninstBtn.disabled = true;
  setToolProgress(tool, 1);
  const phaseEl = document.getElementById(`phase-${tool}`);
  if (phaseEl) {
    phaseEl.textContent = action === "uninstall" ? "Desinstalando…" : action === "install" ? "Descargando…" : "Actualizando…";
    phaseEl.style.color = "";
  }
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "native-tool-action", action, tool });
  } catch {
    res = null;
  }
  if (!res?.ok) {
    if (phaseEl) {
      phaseEl.textContent = res?.error || "Error al comunicarse con el host.";
      phaseEl.style.color = "var(--danger)";
    }
    if (btn) btn.disabled = false;
    if (uninstBtn) uninstBtn.disabled = false;
  }
}

document.getElementById("btn-yt-dlp").addEventListener("click", () => {
  const info = toolInfo("yt-dlp");
  toolAction("yt-dlp", info.status === "installed" ? "update" : "install");
});
document.getElementById("btn-ffmpeg").addEventListener("click", () => {
  const info = toolInfo("ffmpeg");
  toolAction("ffmpeg", info.status === "installed" ? "update" : "install");
});

const btnUninstallYtdl = document.getElementById("btn-uninstall-yt-dlp");
if (btnUninstallYtdl) {
  btnUninstallYtdl.addEventListener("click", () => toolAction("yt-dlp", "uninstall"));
}
const btnUninstallFfmpeg = document.getElementById("btn-uninstall-ffmpeg");
if (btnUninstallFfmpeg) {
  btnUninstallFfmpeg.addEventListener("click", () => toolAction("ffmpeg", "uninstall"));
}

nativeChip.addEventListener("click", openToolsDialog);

async function retargetTab() {
  // En tests (headless) `pin` fija el tabId objetivo: un número lo usa tal
  // cual; `true` busca la pestaña de contenido (la que no es el propio panel).
  const pinned = window.__operant?.pin;
  let tab = null;
  if (typeof pinned === "number") {
    state.tabId = pinned;
  } else {
    try {
      if (pinned === true) {
        const all = await chrome.tabs.query({});
        const panelUrl = chrome.runtime.getURL("panel/panel.html");
        tab = all.find((t) => t.id !== chrome.tabs.TAB_ID_NONE && !t.url?.startsWith(panelUrl) && !t.url?.startsWith("chrome://")) || null;
      } else {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      }
    } catch {
      tab = null;
    }
    state.tabId = tab?.id ?? null;
    console.log(`[operant-panel] retargetTab -> state.tabId=${state.tabId} (pin=${window.__operant?.pin})`);
  }
  if (state.tabId === null) {
    state.items = [];
    loading = false;
    render();
    return;
  }
  await requestState();
}

// Re-aim al cambiar de pestaña activa: el side panel debe seguir a la pestaña
// que el usuario tiene delante, no quedarse mirando la anterior.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (window.__operant?.pin) return; // tests fijan el tab
  state.tabId = tabId;
  loading = true;
  render();
  requestState();
});

// Re-aim al navegar dentro de la pestaña (también cubre el caso de que la
// pestaña cambie de URL sin recarga del panel).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (window.__operant?.pin) return;
  if (tabId !== state.tabId) return;
  if (changeInfo.status === "loading") {
    // La pestaña está cargando otra URL: limpiar la vista vieja.
    state.items = [];
    loading = true;
    render();
  } else if (changeInfo.url) {
    // Cambio de URL (incluye SPA/pushState): refrescar sin vaciar antes
    // (si el SW no responde, se conserva el último estado — bug v0.4).
    requestState();
  }
});

// --- Eventos de UI ---

// Modo grabación: captura los buffers MSE del reproductor de la pestaña y los
// ensambla con ffmpeg del host nativo. Estado gestionado por el SW.
let recState = "idle";
btnRecord.addEventListener("click", async () => {
  if (recState === "recording" || recState === "starting") {
    chrome.runtime.sendMessage({ type: "record-stop" }).catch(() => {});
    statusText.textContent = "Parando la grabación…";
    return;
  }
  if (recState !== "idle") return; // transfiriendo/ensamblando: no tocar
  const r = await chrome.runtime
    .sendMessage({ type: "record-start", tabId: state.tabId })
    .catch((e) => ({ ok: false, error: String(e) }));
  if (!r?.ok) {
    statusText.textContent = r?.error || "No se pudo iniciar la grabación.";
  }
});

btnRefresh.addEventListener("click", async () => {
  statusText.textContent = "Re-escaneando…";
  // Barra de progreso real: force-rescan hace fluir done/total del content script.
  clearTimeout(scanHideTimer);
  scanBar.hidden = false;
  scanFill.style.width = "0%";
  scanText.textContent = "Analizando…";
  scanHideTimer = setTimeout(() => { scanBar.hidden = true; }, 6000);
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "request-scan", tabId: state.tabId });
  } catch {
    res = null;
  }
  if (res && Array.isArray(res.items)) {
    setItems(res.items);
    statusText.textContent = `${state.items.length} medios detectados`;
    render();
  } else {
    statusText.textContent = "No se pudo re-escanear (página no escaneable).";
  }
});

btnStopScan.addEventListener("click", async () => {
  btnStopScan.hidden = true;
  scanText.textContent = "Deteniendo…";
  try {
    await chrome.tabs.sendMessage(state.tabId, { type: "cancel-scan" });
  } catch {
    /* content script no responde (página cerrada o en otra pestaña) */
  }
  scanBar.hidden = true;
});

btnAuto.addEventListener("change", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "set-auto", value: btnAuto.checked });
  } catch {
    /* SW inalcanzable */
  }
});

btnZip.addEventListener("click", downloadZip);

btnYtdl.addEventListener("click", () => {
  const first = sortedItems().find((it) => it.type === "video" || it.type === "audio");
  if (first) downloadWithYtdl(first);
});
btnYtdl.hidden = true;

for (const el of [search, fMinSize, fExt, fDomain]) {
  el.addEventListener("input", () => {
    clearTimeout(render._t);
    render._t = setTimeout(() => {
      saveViewPrefs();
      render();
    }, 80);
  });
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    state.tab = btn.dataset.tab;
    saveViewPrefs();
    render();
  });
});

// --- Petición de tamaños faltantes (resuelve el "…" persistente) ---
let sizeReqInFlight = false;
let sizeReqRetries = 0;
let sizeReqCooldownUntil = 0; // evita bucles: tras agotar reintentos, esperar

async function requestMissingSizes() {
  if (sizeReqInFlight) return;
  if (Date.now() < sizeReqCooldownUntil) return; // cooldown tras reintentos agotados
  sizeReqInFlight = true;
  try {
    const res = await withTimeout(
      chrome.runtime.sendMessage({ type: "get-missing-sizes", tabId: state.tabId }),
      15000
    );
    if (res && Array.isArray(res.items)) {
      // Reemplaza solo si efectivamente hay tamaños nuevos (evita re-render inútil).
      const hasNew = res.items.some((i) => i.sizeKB !== null);
      if (hasNew) {
        setItems(res.items);
        applyPersistedSelection().then(render);
      }
      // Si quedan nulls y aún no hemos reintentado mucho, volver a pedir:
      // algunos tardan (GET pesado) o entraron tarde.
      const stillNull = res.items.filter((i) => i.sizeKB === null && !i.sizeUnknown).length;
      if (stillNull > 0 && sizeReqRetries < 3) {
        sizeReqRetries++;
        setTimeout(() => {
          sizeReqInFlight = false;
          requestMissingSizes();
        }, 2000);
        return;
      }
      sizeReqRetries = 0;
      // Quedan nulls tras agotar reintentos: cooldown para no martillear.
      if (stillNull > 0) sizeReqCooldownUntil = Date.now() + 15000;
    }
  } catch {
    /* SW inalcanzable o timeout: los "…" quedan como estaban */
  } finally {
    sizeReqInFlight = false;
  }
}

// --- Observador de scroll para lazy-render ---
const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      const visible = sortedItems();
      if (state.rendered < visible.length) renderChunk(visible);
    }
  },
  { root: grid, rootMargin: "400px" }
);

// --- Listener del service worker (actualizaciones en vivo) ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "fast-progress") {
    // Progreso de la ruta rápida ejecutada EN EL SW (fallback del overlay):
    // solo reflejar en la barra de estado; los jobs del panel llevan su progreso.
    if (msg.total > 0) {
      statusText.textContent = `Ruta rápida (SW): ${msg.done}/${msg.total} segmentos…`;
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "download-blob") {
    // El SW reenvía un blob capturado DESDE LA PÁGINA (con validación de cabecera
    // Referer). El panel tiene URL.createObjectURL y chrome.downloads.
    // El SW ahora descarga él mismo con data URL (no envía chunks al panel);
    // este receptor queda por compatibilidad con flujos antiguos que enviaban
    // un array plano pequeño o un data URL.
    (async () => {
      try {
        const data = msg.data;
        const mime = msg.mime || "application/octet-stream";
        let bytes;
        if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
          bytes = data;
        } else if (Array.isArray(data)) {
          bytes = Uint8Array.from(data);
        } else if (ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (typeof data === "string" && /^data:/.test(data)) {
          // Fallback data URL (SW sin panel vivo): reconstruir desde base64.
          const comma = data.indexOf(",");
          const b64 = data.slice(comma + 1);
          const bin = atob(b64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          throw new Error("El blob no llegó en un formato válido");
        }
        const blob = new Blob([bytes], { type: mime });
        await dlDeliverBlob(blob, msg.filename || "descarga.mp4");
        statusText.textContent = "Descargado desde la página (con sesión).";
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // respuesta asíncrona
  }
  if (msg.type === "state-updated" && msg.tabId === state.tabId) {
    loading = false; // datos reales: los skeletons nunca se quedan colgados
    setItems(msg.items || []);
    applyPersistedSelection().then(render);
    statusText.textContent = `${state.items.length} medios detectados`;
    if (!scanBar.hidden) {
      scanFill.style.width = "100%";
      const count = state.items.length;
      scanText.textContent = `Escaneo completado · ${count} medio${count === 1 ? "" : "s"} detectado${count === 1 ? "" : "s"} (100%)`;
      clearTimeout(scanHideTimer);
      scanHideTimer = setTimeout(() => { scanBar.hidden = true; }, 450);
    }
    // Si quedan tamaños sin resolver, pedirlos al SW (resuelve el "…").
    if ((msg.items || []).some((i) => i.sizeKB === null)) requestMissingSizes();
    return;
  }
  if (msg.type === "tab-navigated" && msg.tabId === state.tabId) {
    // La página navegó: limpiar la vista para no mostrar caché de la URL vieja
    // mientras el nuevo escaneo puebla. Los datos frescos llegan vía state-updated.
    console.log(`[operant-panel] tab-navigated tabId=${msg.tabId} url=${(msg.url || "").slice(0, 80)}`);
    state.items = [];
    loading = true;
    render();
    statusText.textContent = "Escaneando la nueva página…";
    return;
  }
  if (msg.type === "scan-progress" && msg.tabId === state.tabId) {
    showScanProgress(Number(msg.done) || 0, Number(msg.total) || 0, msg.phase, typeof msg.found === "number" ? msg.found : undefined);
    return;
  }
  if (msg.type === "rec") {
    // Estado del modo grabación (buffers MSE → host nativo).
    recState = msg.state || "idle";
    btnRecord.classList.toggle("recording", recState === "recording" || recState === "starting");
    btnRecord.setAttribute("aria-pressed", String(recState === "recording" || recState === "starting"));
    if (recState === "starting") statusText.textContent = "Iniciando grabación de buffers MSE…";
    else if (recState === "recording") statusText.textContent = `Grabando… ${formatBytes(msg.bytes || 0)} · ${msg.segments || 0} segmentos`;
    else if (recState === "transferring") statusText.textContent = "Entregando buffers al host nativo…";
    else if (recState === "assembling") statusText.textContent = "Ensamblando la grabación con ffmpeg…";
    else if (recState === "error") {
      statusText.textContent = `Grabación: ${msg.message || "error"}`;
      recState = "idle";
    } else if (recState === "idle") statusText.textContent = "";
    return;
  }
  if (msg.type === "native") {
    const m = msg.msg || msg;
    if (recState === "assembling") {
      // Progreso del ffmpeg que ensambla la grabación (el diálogo de
      // procesado no está abierto: todo va a la barra de estado).
      if (m.type === "ffmpeg-progress") {
        statusText.textContent = `Ensamblando grabación… ${m.progress || 0}%`;
      } else if (m.type === "ffmpeg-done") {
        statusText.textContent = `Grabación lista: ${m.name}. Guardada en ${m.output || "~/Downloads/Operant/"}.`;
        recState = "idle";
        btnRecord.classList.remove("recording");
        btnRecord.setAttribute("aria-pressed", "false");
      } else if (m.type === "ffmpeg-error" || m.type === "rec-error") {
        statusText.textContent = `Grabación: ${m.message || "error"}`;
        recState = "idle";
        btnRecord.classList.remove("recording");
        btnRecord.setAttribute("aria-pressed", "false");
      }
      return;
    }
    if (m.type === "progress") {
      const line = m.line || "";
      const pct = line.match(/\[download\]\s+([\d.]+)%/);
      statusText.textContent = pct ? `yt-dlp: ${pct[1]}%…` : `yt-dlp: ${line.slice(0, 60)}…`;
    } else if (m.type === "done") {
      statusText.textContent = `yt-dlp: descarga completada en ${m.folder || "Downloads/Operant"}.`;
    } else if (m.type === "error") {
      statusText.textContent = `yt-dlp: ${m.message || "error"}`;
    } else if (m.type === "ffmpeg-progress") {
      procBar.value = m.progress || 0;
      procStatus.textContent = m.phase === "download"
        ? `Descargando a tu PC… ${m.progress}%`
        : `Procesando con ffmpeg… ${m.progress}%`;
      procStatus.className = "proc-status busy";
    } else if (m.type === "ffmpeg-done") {
      procBar.value = 100;
      const before = formatBytes(m.sizeBefore || 0);
      const after = formatBytes(m.sizeAfter || 0);
      procStatus.textContent = `Listo: ${m.name} (${before} → ${after}). Guardado en ${m.output || "~/Downloads/Operant/"}.`;
      procStatus.className = "proc-status ok";
      procRun.disabled = false;
    } else if (m.type === "ffmpeg-error") {
      procStatus.textContent = `Error: ${m.message || "desconocido"}`;
      procStatus.className = "proc-status err";
      procRun.disabled = false;
    } else if (m.type === "formats") {
      renderFormats(m.formats || []);
    } else if (m.type === "formats-error") {
      qualityStatus.textContent = m.message || "Error al listar formatos.";
      qualityStatus.className = "proc-status err";
      qualityRun.disabled = false;
    } else if (m.type === "tool-progress") {
      setToolProgress(m.tool, m.progress);
      const phase = document.getElementById(`phase-${m.tool}`);
      if (phase) phase.textContent = `${m.phase} ${m.progress}%`;
    } else if (m.type === "tool-done") {
      setToolProgress(m.tool, 100);
      const phase = document.getElementById(`phase-${m.tool}`);
      if (phase) phase.textContent = `${TOOL_LABELS[m.tool]} instalado (v${m.version}).`;
      const btn = document.getElementById(`btn-${m.tool}`);
      if (btn) btn.disabled = false;
      state.native = { ...state.native, checkedAt: 0 };
      refreshNativeStatus();
      renderTools();
    } else if (m.type === "tool-uninstalled") {
      setToolProgress(m.tool, 0);
      const phase = document.getElementById(`phase-${m.tool}`);
      if (phase) {
        phase.textContent = `${TOOL_LABELS[m.tool] || m.tool} desinstalado de ~/Operant/bin/.`;
        phase.style.color = "var(--text-muted)";
      }
      const btn = document.getElementById(`btn-${m.tool}`);
      if (btn) btn.disabled = false;
      const uninstBtn = document.getElementById(`btn-uninstall-${m.tool}`);
      if (uninstBtn) {
        uninstBtn.disabled = false;
        uninstBtn.hidden = true;
      }
      state.native = { ...state.native, checkedAt: 0 };
      if (m.tools) {
        state.native.tools = m.tools;
      }
      refreshNativeStatus();
      renderTools();
    } else if (m.type === "tool-error") {
      const phase = document.getElementById(`phase-${m.tool}`);
      if (phase) {
        phase.textContent = `Error: ${m.message || "desconocido"}`;
        phase.style.color = "var(--danger)";
      }
      const btn = document.getElementById(`btn-${m.tool}`);
      if (btn) btn.disabled = false;
      setToolProgress(m.tool, 0);
    } else if (m.type === "pong" || m.type === "tools-status") {
      if (m.tools) {
        state.native = { installed: true, checkedAt: Date.now(), tools: m.tools };
        renderNativeChip();
        renderTools();
      }
    }
  }
});

// --- Gestión de Tema (Warm Ink Neutrals sinc con la web) ---
let currentThemeSetting = "dark";

function resolveEffectiveTheme(pref) {
  if (pref === "system") {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref === "light" ? "light" : "dark";
}

function updateThemeSegmentUI(setting) {
  document.querySelectorAll(".theme-segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeVal === setting);
  });
}

function setTheme(themeSetting, save = true) {
  currentThemeSetting = themeSetting;
  const effectiveTheme = resolveEffectiveTheme(themeSetting);
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.dataset.theme = effectiveTheme;

  try {
    localStorage.setItem("theme", themeSetting);
  } catch {}

  if (save) {
    chrome.storage.local.set({ theme: themeSetting });
  }

  updateThemeSegmentUI(themeSetting);
  setTimeout(() => root.classList.remove("theme-switching"), 100);
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {}

  if (stored) {
    setTheme(stored, false);
  } else {
    chrome.storage.local.get(["theme"], (data) => {
      const pref = data?.theme || "dark";
      setTheme(pref, false);
    });
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (currentThemeSetting === "system") {
        setTheme("system", false);
      }
    });
  }
}

const themeToggle = document.getElementById("themeToggle");
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const curEffective = document.documentElement.dataset.theme || "dark";
    const next = curEffective === "dark" ? "light" : "dark";
    setTheme(next, true);
  });
}

document.querySelectorAll(".theme-segment-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const val = btn.dataset.themeVal;
    if (val) setTheme(val, true);
  });
});

const btnCompanionHeader = document.getElementById("btnCompanionHeader");
if (btnCompanionHeader) {
  btnCompanionHeader.addEventListener("click", openToolsDialog);
}

const btnReconnectHost = document.getElementById("btnReconnectHost");
if (btnReconnectHost) {
  btnReconnectHost.addEventListener("click", async () => {
    btnReconnectHost.disabled = true;
    btnReconnectHost.textContent = "Verificando…";
    state.native.checkedAt = 0;
    try {
      const res = await chrome.runtime.sendMessage({ type: "native-tools-status" });
      if (res?.status) state.native = res.status;
    } catch {}
    await refreshNativeStatus();
    renderTools();
    btnReconnectHost.disabled = false;
    btnReconnectHost.textContent = "Reconectar";
  });
}

// --- Arranque ---
(async () => {
  initTheme();
  await loadViewPrefs();
  let data = {};
  try {
    data = await chrome.storage.local.get(["autoDetect", "dlConcurrency", "overlayEnabled", "overlayMinSize", "overlayIgnoreSvg"]);
  } catch {
    data = {};
  }
  btnAuto.checked = data.autoDetect !== false;
  chkOverlay.checked = data.overlayEnabled !== false;
  dlConcurrencyValue = Math.max(1, Math.min(8, data.dlConcurrency || 3));
  dlConcurrency.value = dlConcurrencyValue;
  if (chkOverlayIgnoreSvg) chkOverlayIgnoreSvg.checked = data.overlayIgnoreSvg !== false;
  if (overlayMinSizeInput) {
    const min = Number(data.overlayMinSize);
    overlayMinSizeInput.value = String(Number.isFinite(min) && min >= 0 ? min : 0);
  }
  await retargetTab();
  refreshNativeStatus();
})();

// --- Hooks de pruebas (auditoría headless) ---
window.__operant = {
  pin: false,
  retargetTab,
  startDl: dlStart,
  dlState: dlSummary,
  getState: () => ({ items: state.items, tab: state.tab, tabId: state.tabId, selected: [...state.selected], loading }),
  setState(items, opts = {}) {
    state.items = Array.isArray(items) ? items : [];
    loading = false;
    if (opts.resetFilters) {
      search.value = "";
      fMinSize.value = "0";
      fExt.value = "";
      fDomain.value = "";
      viewPrefs.hideSmall = false;
      chkHideSmall.checked = false;
    }
    if (opts.tab && TABS.includes(opts.tab)) {
      state.tab = opts.tab;
      document.querySelectorAll(".tab").forEach((b) => {
        const on = b.dataset.tab === state.tab;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
    }
    populateExtOptions();
    render();
  },
  // Verifica el contenido del zip (misma lógica que el botón real).
  zipCount: async (urls) => {
    const r = await buildZipFromUrls(urls);
    return { ok: r.okCount, fail: r.failCount };
  },
};
