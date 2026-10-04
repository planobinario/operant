// background.js — Service worker de Operant.
// Responsabilidades:
//   1. Abrir el side panel al hacer clic en el icono (chrome.sidePanel).
//   2. Capturar streams de red con webRequest (m3u8, mpd, mp4… que no están en el DOM).
//   3. Centralizar el estado por pestaña y enriquecer items con tamaño (HEAD).
//   4. Comunicarse con el host nativo (yt-dlp/ffmpeg) vía Native Messaging.

// ÚNICA FUENTE DE VERDAD de detección/descarga (compartida con el panel).
import { OperantMedia } from "./shared/media-core.js";
// Ruta rápida HLS 100% en navegador (mismo motor que ejecuta el panel):
// parseo m3u8 + fetch paralelo + AES-128 (WebCrypto) + concat fMP4/TS.
import { HLSFast } from "./shared/hls-fast.js";
// ÚNICA FUENTE DE VERDAD de nombres de archivo (compartida con el panel).
// Todo lo que va a chrome.downloads.download({filename}) pasa por aquí.
import {
  sanitizeFileName,
  basenameFromUrl,
  filenameFromResponse,
  mimeToExt,
  ensureExtension,
} from "./shared/filename.js";
// Punto de entrada del panel lateral. La build de Firefox sustituye este
// import por ./panel-entry-gecko.js (ver scripts/build-firefox.mjs).
import { setupPanelOnInstalled } from "./panel-entry-chromium.js";

const NATIVE_HOST = "com.operant.native_host";
const MAX_ITEMS_PER_TAB = 4000;

// --- Anti-hotlink genérico (no hardcodeado por sitio) ---
// El fetch DESDE la página a un CDN cross-origin que NO manda
// Access-Control-Allow-Origin muere por CORS, y el fetch del SW sin Referer da
// 403/410. Solución de raíz: el SW hace el fetch (sin CORS con <all_urls>) y
// declarativeNetRequest le inyecta el Referer REAL de la página, en una regla
// por descarga (se elimina al terminar). Así funciona con cualquier CDN con
// anti-hotlink sin lista de sitios.
//
// TRES CORRECCIONES IMPORTANTES sobre la implementación anterior:
//
// 1. `updateSessionRules` en lugar de `updateDynamicRules`. Las reglas
//    dinámicas SOBREVIVEN a reinicios del navegador y a actualizaciones de la
//    extensión, pero la intención documentada era "regla EFÍMERA". Con
//    updateDynamicRules, cualquier fuga (un service worker terminado a mitad de
//    una descarga no ejecuta su `finally`) dejaba un Referer obsoleto inyectado
//    en peticiones de la extensión de forma indefinida. Las de sesión se
//    limpian al cerrar el navegador y al instalar una versión nueva.
//
// 2. `urlFilter` con la URL ESCAPADA. `urlFilter` es un lenguaje de patrón
//    (caracteres especiales: * | ^ : ? - \), no un literal. Con la URL cruda un
//    `?` —presente en toda URL firmada— era comodín, y un `|` legal en un
//    query partía el filtro en un OR de dos patrones, con lo que el Referer de
//    la página acababa en URLs no pretendidas.
//
// 3. IDs de un contador con anillo, no un hash de la URL. El hash colapsaba en
//    999 ranuras (≈3 % de colisión con 8 descargas en vuelo) y una colisión
//    hacía que una descarga BORRARA la regla Referer de otra: 403 en un
//    archivo diferente, con el `finally` de una borrando la de la otra.

// Espacio de IDs. Las session rules de Chrome admiten 5000; se deja margen
// para no agotar la cuota en versiones antiguas, donde se comparte con las
// dinámicas.
const DNR_RULE_BASE = 7000;
const DNR_RULE_SPACE = 4000;

// Clave -> id de regla vivo. Una sola autoridad para los dos tipos de regla
// (por URL y por host), con lo que no pueden colisionar entre sí.
const dnrAuthRules = new Map();
let dnrNextRuleId = DNR_RULE_BASE + 1;

function allocDnrRuleId() {
  if (dnrNextRuleId >= DNR_RULE_BASE + DNR_RULE_SPACE) {
    // Anillo agotado (no ocurre en uso real: ~20 reglas vivas). Se reinicia el
    // contador; los IDs reutilizados sustituyen a las reglas anteriores, y
    // todas son de sesión, así que no queda estado persistente que corromper.
    dnrNextRuleId = DNR_RULE_BASE + 1;
  }
  return dnrNextRuleId++;
}

// Escapa los metacaracteres del lenguaje urlFilter de declarativeNetRequest
// para que la URL se trate como literal.
function dnrEscapeFilter(value) {
  return String(value).replace(/[*|^:?\\]/g, (ch) => `\\${ch}`);
}

// Cabecera Cookie para una URL, si el usuario ha concedido el permiso
// `cookies`. Es la ÚNICA vía bajo MV3 para reenviar cookies HttpOnly en un
// fetch del service worker: el content script no puede leerlas y el service
// worker no las ve sin ese permiso. Sin permiso devuelve "" y el
// comportamiento es el de siempre (credentials:"include" + Referer).
const COOKIE_HEADER_MAX = 3800; // límite típico de servidor para una cabecera

async function cookieHeaderFor(url) {
  if (typeof chrome === "undefined" || !chrome.cookies) return "";
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    const parts = [];
    let len = 0;
    for (const c of cookies) {
      const piece = `${c.name}=${c.value}`;
      if (len + piece.length + 2 > COOKIE_HEADER_MAX) break;
      parts.push(piece);
      len += piece.length + 2;
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

// Estado del permiso opcional `cookies`. Se cachea para no consultarlo en cada
// descarga; chrome.cookies ya es undefined sin el permiso, así que este valor
// solo se usa para decidir si merece la pena construir la cabecera Cookie.
let cookiesPermGranted = false;
async function hasCookiesPermission() {
  try {
    cookiesPermGranted = await chrome.permissions.contains({ permissions: ["cookies"] });
  } catch {
    cookiesPermGranted = false;
  }
  return cookiesPermGranted;
}

// Inyecta Referer (y Cookie si hay permiso) en las peticiones de la extensión
// hacia una URL o un host. `key` identifica la regla viva para poder retirarla.
async function dnrInstallAuthRule(key, filter, referer) {
  if (!chrome.declarativeNetRequest) return false;
  const headers = [];
  if (referer) headers.push({ header: "Referer", operation: "set", value: referer });
  if (await hasCookiesPermission()) {
    const cookie = await cookieHeaderFor(filter);
    if (cookie) headers.push({ header: "Cookie", operation: "set", value: cookie });
  }
  if (!headers.length) return false;

  const id = allocDnrRuleId();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders: headers },
          condition: {
            initiatorDomains: [chrome.runtime.id], // solo peticiones de la extensión
            resourceTypes: ["xmlhttprequest", "media", "other"],
            isUrlFilterCaseSensitive: true,
            urlFilter: dnrEscapeFilter(filter),
          },
        },
      ],
    });
    dnrAuthRules.set(key, id);
    return true;
  } catch (e) {
    console.log(`[operant-sw] DNR rule failed (${String(key).slice(0, 80)}): ${String(e?.message || e)}`);
    return false;
  }
}

async function dnrRemoveAuthRule(key) {
  if (!chrome.declarativeNetRequest) return;
  const id = dnrAuthRules.get(key);
  if (id === undefined) return;
  dnrAuthRules.delete(key);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch {
    /* la regla desaparece igualmente al cerrar el navegador */
  }
}

// Regla por URL exacta (filtro escapado).
function dnrSetAuthRule(url, referer) {
  return dnrInstallAuthRule(`url:${url}`, url, referer);
}
function dnrClearAuthRule(url) {
  return dnrRemoveAuthRule(`url:${url}`);
}

// Regla por HOST: cubre los cientos de segmentos de un m3u8 sin crear una
// regla por segmento, que agotaría la cuota y sería O(n) mensajes.
function dnrSetRefererHostRule(hostname, referer) {
  if (!hostname) return Promise.resolve(false);
  return dnrInstallAuthRule(`host:${hostname}`, `||${hostname}`, referer);
}
function dnrClearRefererHostRule(hostname) {
  return dnrRemoveAuthRule(`host:${hostname}`);
}

// Mantiene viva una regla de auth durante toda la operación `fn` y la retira al
// terminar (éxito, error o cancelación). Esto es lo que permite que la descarga
// DIRECTA con chrome.downloads.download funcione contra CDN con anti-hotlink:
// esa petición la hace el gestor de descargas del navegador —que sí lleva las
// cookies del perfil— pero sin Referer, que es justo lo que muchos CDNs
// comprueban. La regla cubre `initiatorDomains: [extensión]`, que incluye las
// peticiones iniciadas por el gestor de descargas de la extensión.
async function withDnrAuth(url, pageUrl, fn) {
  if (!pageUrl || !/^https?:/i.test(url || "")) return fn();
  const installed = await dnrSetAuthRule(url, pageUrl);
  try {
    return await fn();
  } finally {
    if (installed) await dnrClearAuthRule(url);
  }
}


// Construye la lista de URLs a descargar para un track DASH: init segment
// (si existe) + todos los media segments del .mpd. Si el parser no generó
// segmentos (manifiesto sin SegmentTemplate), usa la URL única del track.
function buildSegList(q) {
  if (q && Array.isArray(q.segments) && q.segments.length) {
    const list = [];
    if (q.initUrl) list.push(q.initUrl);
    for (const s of q.segments) list.push(s);
    return list;
  }
  return q && q.url ? [q.url] : [];
}

// --- Estado por pestaña ---
const tabs = new Map(); // tabId -> { items: [], seenNetwork: Set<string> }
const sizeCache = new Map(); // url -> sizeKB

// Secuencia global de detección (ORDEN ESTABLE DE RAÍZ): cada item recibe un
// seq MONOTONO una sola vez, en el momento en que entra al estado central.
// El panel ordena por este seq: es inmutable ante re-escaneos, mezclas y
// actualizaciones de tamaño — el orden de aparición nunca "salta" al volver
// de una pestaña a otra (los _idx reasignados por mensaje eran la causa raíz).
let seqCounter = 1;
function nextSeq() {
  return seqCounter++;
}
function withSeq(item) {
  if (item && item.seq === undefined) item.seq = nextSeq();
  return item;
}

function ensureTab(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, { items: [], seenNetwork: new Set() });
  }
  return tabs.get(tabId);
}

function keyFor(tabId) {
  return `tab_${tabId}`;
}

async function persistTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  try {
    await chrome.storage.session.set({ [keyFor(tabId)]: tab.items.slice(0, MAX_ITEMS_PER_TAB) });
  } catch {
    /* cuota excedida o SW durmiendo: ignorar */
  }
}

// --- Fase 1: Side Panel API ---
// --- Punto de entrada del panel lateral ---
//
// La implementación NO está aquí sino en `panel-entry-chromium.js`, y la build de
// Firefox la sustituye por `panel-entry-gecko.js`. Motivo: `chrome.sidePanel`
// es una API exclusiva de Chromium, y cualquier referencia a ella en el paquete
// de Firefox la marca addons-linter como UNSUPPORTED_API. Aislarlo por target
// deja el código correcto en ambos navegadores SIN tener que ocultar la
// referencia para silenciar al linter.
//
// Lo que sí había era un bug real: la versión anterior llamaba a
// `chrome.sidePanel.setPanelBehavior(...)` dentro de un `.catch(() => {})` que
// se tragaba el `TypeError`, de modo que en Firefox la extensión se instalaba y
// el icono de la barra no abría nada, sin un solo error visible.
chrome.runtime.onInstalled.addListener(() => {
  setupPanelOnInstalled();
  chrome.storage.local.get(["autoDetect"], (data) => {
    if (data.autoDetect === undefined) chrome.storage.local.set({ autoDetect: true });
  });
});

// Badge con el nº de medios de la pestaña activa (acento de marca).
chrome.action.setBadgeBackgroundColor({ color: "#f2554d" }).catch(() => {});
chrome.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});

function updateBadge(tabId) {
  const tab = tabs.get(tabId);
  const n = tab ? tab.items.length : 0;
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : "" }).catch(() => {});
}

// Limpieza al cerrar pestañas.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
});

// --- Aislamiento por navegación (Bug 1): al navegar a otra URL se borra el
// estado anterior del tabId ANTES de que llegue el nuevo escaneo. frameId 0
// = navegación del documento principal (no de iframes). Se cubre también la
// navegación SPA (onHistoryStateUpdated: pushState sin recarga de documento),
// donde el content script sigue vivo y su store local debe reiniciarse.
chrome.webNavigation?.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    const tabId = details.tabId;
    const oldCount = tabs.get(tabId)?.items.length ?? 0;
    tabs.delete(tabId); // reinicia items + seenNetwork
    console.log(
      `[operant-sw] NAVIGATION tabId=${tabId} oldItems=${oldCount} url=${details.url.slice(0, 90)} (onCommitted)`
    );
    chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
    updateBadge(tabId); // el badge no debe quedar rancio tras navegar
    // Avisa al panel para que no muestre la caché vieja mientras escanea.
    chrome.runtime
      .sendMessage({ type: "tab-navigated", tabId, url: details.url })
      .catch(() => {});
  },
  { url: [{ schemes: ["http", "https"] }] }
);

chrome.webNavigation?.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    const tabId = details.tabId;
    console.log(
      `[operant-sw] SPA-NAV tabId=${tabId} url=${details.url.slice(0, 90)} (onHistoryStateUpdated)`
    );
    // SPA: el content script sigue vivo. Se le pide reiniciar su store para
    // no arrastrar items de la vista anterior.
    chrome.tabs.sendMessage(tabId, { type: "reset-state" }).catch(() => {});
    updateBadge(tabId);
  },
  { url: [{ schemes: ["http", "https"] }] }
);

// --- Fase 2: captura de red con webRequest (observación, sin bloquear) ---
const MEDIA_REQUEST_TYPES = new Set(["media", "xmlhttprequest", "other"]);

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

function urlExt(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]+)(?:$|[?#])/i);
    return m ? `.${m[1].toLowerCase()}` : "";
  } catch {
    return "";
  }
}

// Nombre de archivo SEGURO derivado de la URL. Delega en shared/filename.js,
// que decodifica el último segmento ANTES de sanearlo: así un %2F que ocultaba
// un separador vuelve a ser "_" en lugar de recuperar su significado de ruta.
// Antes se hacía split("/") y luego decodeURIComponent, con lo que
// `a%2F..%2F..%2Fevil.png` producía un nombre con separadores de ruta.
function urlBasename(url) {
  return basenameFromUrl(url);
}

// Punto único de entrada para TODO nombre que se entrega a
// chrome.downloads.download. Garantiza que el nombre es plano (sin separadores
// ni ".."), sin caracteres de control ni invisibles, sin nombres reservados de
// Windows, en NFC y acotado en bytes.
//
// `preferred` es lo que el panel o el overlay proponen (suele venir del alt o
// del title de la página: no es de fiar). `url` es la fuente de respaldo.
// `ext` y `mime` son opcionales y sirven para no dejar el archivo sin extensión
// cuando la URL es opaca (/download?token=…).
function safeDownloadName(preferred, url, ext, mime) {
  const fromPreferred = preferred ? sanitizeFileName(preferred, { fallback: "" }) : "";
  const base = fromPreferred || urlBasename(url) || "descarga";
  const resolvedExt = (ext && String(ext).replace(/^\./, "")) || mimeToExt(mime) || "";
  return ensureExtension(base, resolvedExt);
}

// --- Bytes: utilidades sin asignaciones masivas ---
// String.fromCharCode(...) con un array grande revienta por stack overflow
// (límite de argumentos de la llamada). Estas dos funciones lo evitan sin
// construir nunca una cadena gigante a mano, y son O(n) con memoria acotada.

// ¿Aparece la subcadena ASCII `needle` en los primeros `window` bytes?
// Se comparan BYTES, no caracteres: no materializa nada.
function bytesContainAscii(bytes, needle, window) {
  if (!bytes || !needle) return false;
  const n = needle.length;
  const limit = Math.min(bytes.length, window === undefined ? bytes.length : window);
  if (n === 0 || limit < n) return false;
  const first = needle.charCodeAt(0);
  for (let i = 0; i <= limit - n; i++) {
    if (bytes[i] !== first) continue;
    let j = 1;
    while (j < n && bytes[i + j] === needle.charCodeAt(j)) j++;
    if (j === n) return true;
  }
  return false;
}

// Texto ASCII/latin1 de los primeros `window` bytes, sin stack overflow.
function asciiHead(bytes, window) {
  const limit = Math.min(bytes.length, window);
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < limit; i += CHUNK) {
    const end = Math.min(i + CHUNK, limit);
    let piece = "";
    for (let j = i; j < end; j++) piece += String.fromCharCode(bytes[j]);
    s += piece;
  }
  return s;
}

function formatBytesKB(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!MEDIA_REQUEST_TYPES.has(details.type)) return;
    const kind = classify(details.url);
    if (!kind) return;

    const tab = ensureTab(details.tabId);
    const key = details.url.split("#")[0];
    if (tab.seenNetwork.has(key)) return;
    tab.seenNetwork.add(key);

    // Init segments de fMP4 (DASH de X/Instagram): metadata vacía (moov/trak
    // sin mdat) — NO son vídeos descargables. Se marcan para que la UI y la
    // descarga los ignoren (evita el bug del "vídeo de 786B/903B").
    const looksLikeInitUrl =
      /(?:^|[\/._-])(?:init|header)(?:[\/._-]|$)/i.test(details.url) ||
      /\/init[^/]*\.(mp4|m4s|m4v)(?:[?#]|$)/i.test(details.url);

    const item = withSeq({
      url: details.url,
      type: kind,
      ext: extOf(details.url),
      domain: domainOf(details.url),
      sizeKB: null,
      sizeUnknown: false,
      source: "network",
      // Método de detección: el sniffing de red es el "nivel 2" de la
      // jerarquía (después del DOM directo); los manifiestos se etiquetan
      // para que la UI ofrezca parseo propio en vez de caer a yt-dlp.
      method:
        looksLikeInitUrl && kind === "video"
          ? "init" // NO descargable: init segment (metadata sin vídeo)
          : kind === "video" && /\.(m3u8|mpd)(?:[?#].*)?$/i.test(details.url)
            ? "manifest"
            : "network",
    });
    tab.items.push(item);
    if (tab.items.length > MAX_ITEMS_PER_TAB) tab.items.shift();

    // Enviar al content script para que lo añada a su propio store.
    chrome.tabs.sendMessage(details.tabId, { type: "network-media", items: [item] }).catch(() => {});
    enrichSize(item);
    updateBadge(details.tabId);
    persistTab(details.tabId);
  },
  { urls: ["<all_urls>"] },
  []
);

// --- Enriquecimiento: tamaño real del recurso ---
//
// ORDEN DE LA ESCALERA (de más barata a más cara). El orden importa mucho: la
// versión anterior empezaba por un GET COMPLETO del archivo (nivel 1) y solo
// después probaba HEAD (nivel 2), contra su propio comentario. En una página
// con un vídeo de 2 GB eso significaba descargar 2 GB a RAM del service worker
// para poder pintar "2.0 GB" en el grid.
//
//   0. Performance Resource Timing (sizeBytes del content script): el navegador
//      ya cargó el recurso y registró encodedBodySize — cero peticiones.
//   1. HEAD + Content-Length: una cabecera, sin cuerpo. Cubre la mayoría.
//   2. Range GET de 1 byte + Content-Range: cubre los servidores que responden
//      405/501 a HEAD pero sí aceptan Range. Cuesta 1 byte, no el archivo.
//   3. HEAD/GET con Referer vía DNR: muchos CDN con anti-hotlink rechazan
//      cualquier petición sin el Referer de la página.
//   4. GET con Referer vía DNR, LEYENDO COMO MÁXIMO `FULL_GET_MAX` bytes: solo
//      para recursos cuyo Content-Length es desconocido o miente, y nunca más
//      allá del tope. Antes este nivel era un GET sin límite en el camino
//      caliente de webRequest, sin concurrencia acotada.
//
// Semáforo global: el camino de `webRequest.onBeforeRequest` llama a enrichSize
// por cada request de media detectado, sin ningún tope. Con 500 recursos en una
// página eso son 500 peticiones de tamaño simultáneas. Ahora comparte el mismo
// semáforo que enrichMissing.

const ENRICH_TIMEOUT_MS = 8000;
// Tope absoluto de bytes que se leen en el nivel 4 (GET completo). Por encima
// de esto el recurso se marca como desconocido en lugar de descargarse entero:
// es preferible mostrar "?" que agotar la memoria del service worker.
const FULL_GET_MAX = 8 * 1024 * 1024;

let enrichInFlight = 0;
const enrichWaiters = [];
const ENRICH_MAX_CONCURRENT = 8;

async function enrichAcquire() {
  if (enrichInFlight < ENRICH_MAX_CONCURRENT) {
    enrichInFlight++;
    return;
  }
  await new Promise((resolve) => enrichWaiters.push(resolve));
  enrichInFlight++;
}

function enrichRelease() {
  enrichInFlight--;
  const next = enrichWaiters.shift();
  if (next) next();
}

// fetch con timeout cuyo temporizador SIEMPRE se limpia. Antes, cuando el
// fetch fallaba por una causa distinta del abort (DNS, offline, respuesta
// opaca), el temporizador de 5-8 s se quedaba vivo para siempre: hasta tres
// temporizadores fugados por item fallido, en un service worker que no
// reinicia nunca.
async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Total en bytes según Content-Range ("bytes 0-0/12345" → 12345) o
// Content-Length. 0 si no se puede saber.
function declaredTotalBytes(res) {
  const range = res.headers.get("content-range");
  if (range) {
    const total = Number(range.split("/")[1]);
    if (Number.isFinite(total) && total > 0) return total;
  }
  const len = Number(res.headers.get("content-length") || 0);
  return Number.isFinite(len) && len > 0 ? len : 0;
}

// Referer de la página, solo si el recurso es de otro dominio (si es del mismo,
// el fetch ya lo lleva y la regla DNR es ruido).
function refererNeeded(itemUrl, pageUrl) {
  if (!pageUrl || !/^https?:/i.test(itemUrl)) return "";
  try {
    return new URL(itemUrl).hostname === new URL(pageUrl).hostname ? "" : pageUrl;
  } catch {
    return "";
  }
}

async function enrichSize(item, pageUrl = "") {
  if (sizeCache.has(item.url)) {
    item.sizeKB = sizeCache.get(item.url);
    item.sizeUnknown = item.sizeKB === 0;
    return;
  }
  if (/^blob:|^data:/.test(item.url)) {
    item.sizeKB = 0;
    item.sizeUnknown = true;
    return;
  }
  if (!/^https?:/i.test(item.url)) {
    item.sizeKB = 0;
    item.sizeUnknown = true;
    return;
  }

  let len = 0;

  // Nivel 0: el navegador ya lo cargó y lo sabe.
  if (item.sizeBytes && item.sizeBytes > 0) {
    len = item.sizeBytes;
  }

  await enrichAcquire();
  try {
    const ref = refererNeeded(item.url, pageUrl);

    // Nivel 1: HEAD. Una cabecera, sin cuerpo.
    if (len <= 0) {
      try {
        const res = await fetchWithTimeout(item.url, { method: "HEAD", cache: "no-store" }, ENRICH_TIMEOUT_MS);
        len = declaredTotalBytes(res);
      } catch {
        len = 0;
      }
    }

    // Nivel 2: Range de 1 byte. Cubre HEAD → 405/501, que es lo que hacen
    // muchos CDN. El total viene en Content-Range.
    if (len <= 0) {
      try {
        const res = await fetchWithTimeout(
          item.url,
          { headers: { Range: "bytes=0-0" }, cache: "no-store" },
          ENRICH_TIMEOUT_MS
        );
        len = declaredTotalBytes(res);
      } catch {
        len = 0;
      }
    }

    // Nivel 3: HEAD con Referer real (anti-hotlink por cabecera).
    if (len <= 0 && ref) {
      try {
        const res = await withDnrAuth(item.url, ref, () =>
          fetchWithTimeout(
            item.url,
            { method: "HEAD", referrer: ref, referrerPolicy: "unsafe-url", cache: "no-store" },
            ENRICH_TIMEOUT_MS
          )
        );
        len = declaredTotalBytes(res);
      } catch {
        len = 0;
      }
    }

    // Nivel 4: GET con Referer, LEYENDO COMO MÁXIMO FULL_GET_MAX. Es el único
    // nivel que transfiere cuerpo, y está acotado: si al terminar no se conoce
    // el total, el item se marca desconocido en vez de descargarse entero.
    if (len <= 0) {
      try {
        const res = await withDnrAuth(item.url, ref, () =>
          fetchWithTimeout(
            item.url,
            { headers: { Range: `bytes=0-${FULL_GET_MAX - 1}` }, referrer: ref, referrerPolicy: "unsafe-url", cache: "no-store" },
            ENRICH_TIMEOUT_MS
          )
        );
        const declared = declaredTotalBytes(res);
        if (declared > 0) {
          len = declared; // el servidor sí declara el total: no hace falta el cuerpo
        } else {
          // Content-Range ausente y 200: el cuerpo es el archivo entero. Se
          // lee hasta el tope y se cuenta.
          const reader = res.body?.getReader?.();
          if (reader) {
            let read = 0;
            while (read < FULL_GET_MAX) {
              const { done, value } = await reader.read();
              if (done) {
                len = read; // EOF antes del tope: este ES el tamaño total
                break;
              }
              read += value.byteLength;
            }
            try {
              await reader.cancel();
            } catch {
              /* el stream ya está cerrado */
            }
            if (len === 0 && read >= FULL_GET_MAX) len = 0; // troncado: desconocido
          }
        }
      } catch {
        len = 0;
      }
    }
  } finally {
    enrichRelease();
  }

  const sizeKB = len > 0 ? Math.max(1, Math.round(len / 1024)) : 0;
  item.sizeKB = sizeKB;
  item.sizeUnknown = len <= 0;
  item.sizeBytes = len > 0 ? len : null;
  sizeCache.set(item.url, sizeKB);
}


// Enriquecer tamaños de los items que aún no tienen (fetch HEAD con caché).
// Concurrencia limitada (8); broadcast de progreso THROTTLED (máx. 1/800ms)
// — antes enviaba un state-updated POR ITEM resuelto y el panel re-renderizaba
// el grid entero cientos de veces (tormenta de renders). Re-entrada
// protegida por pestaña: los media-updated en ráfaga no acumulan workers.
const enriching = new Set();
const enrichRerun = new Set();

async function enrichMissing(tabId) {
  if (enriching.has(tabId)) {
    enrichRerun.add(tabId); // items nuevos durante la pasada: re-ejecutar al final
    return;
  }
  const tab = tabs.get(tabId);
  if (!tab) return;
  const pendientes = tab.items.filter((i) => i.sizeKB === null && !i.sizeUnknown);
  if (!pendientes.length) return;
  console.log(`[operant-sw] enrichMissing tabId=${tabId}: ${pendientes.length} pendientes`);
  enriching.add(tabId);
  // URL de la pestaña: necesaria para la técnica 1.5 (Referer vía DNR).
  let pageUrl = "";
  try {
    const t = await chrome.tabs.get(tabId);
    pageUrl = t?.url || "";
  } catch {
    pageUrl = "";
  }
  let idx = 0;
  let processed = 0;
  let lastBroadcastAt = 0;
  const broadcast = (force = false) => {
    if (!autoDetect) return;
    const now = Date.now();
    if (!force && now - lastBroadcastAt < 800) return;
    lastBroadcastAt = now;
    chrome.runtime.sendMessage({ type: "state-updated", tabId, items: tab.items }).catch(() => {});
  };
  const worker = async () => {
    while (idx < pendientes.length) {
      const item = pendientes[idx++];
      await enrichSize(item, pageUrl); // usa sizeCache: no repite HEAD ya hecho
      processed++;
      persistTab(tabId);
      broadcast();
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pendientes.length) }, worker));
  enriching.delete(tabId);
  broadcast(true); // estado final del lote
  const stillNull = tab.items.filter((i) => i.sizeKB === null).length;
  console.log(`[operant-sw] enrichMissing fin tabId=${tabId}: procesados=${processed}, quedanNull=${stillNull}`);
  if (enrichRerun.delete(tabId)) enrichMissing(tabId);
  // Con tamaños conocidos: clasificar relaciones de stream (variantes/audio)
  // y reflejar los cambios (una sola vez por pasada, no por item).
  classifyStreamRelations(tabId)
    .then((changed) => {
      if (!changed) return;
      persistTab(tabId);
      updateBadge(tabId);
      if (autoDetect) {
        chrome.runtime.sendMessage({ type: "state-updated", tabId, items: tab.items }).catch(() => {});
      }
    })
    .catch(() => {});
}

// La cadena de detección/descarga (HEAD → Range → magic bytes → parseo de
// manifiesto) vive en src/shared/media-core.js (OperantMedia) — ÚNICA fuente de
// verdad, compartida con el panel. Aquí solo se ejecuta la estrategia.

// --- Mensajería con el panel ---
let autoDetect = true;
let mediaBlastAt = 0; // último broadcast media-updated (throttle 300ms)

// --- Clasificación de RELACIONES de stream (X/Twitter, YouTube Live…) ---
// Los reproductores MSE capturan múltiples piezas del MISMO vídeo: master
// m3u8, variantes solo-vídeo, pistas de audio (m3u8 y mp4). Sin relaciones,
// el panel muestra el mismo vídeo 3 veces (vídeo, vídeo mudo, solo audio).
// Esta pasada (cacheada por URL, throttled) etiqueta:
//   · pistas de audio  → type "audio" (pestaña Audio)
//   · variantes/componentes → component: true (ocultos en la UI)
//   · el master queda como la ÚNICA entrada de ese vídeo (mux con companion).
const streamProbeCache = new Map(); // url de playlist → { kind, videoUrls, audioUrls }

async function probePlaylist(url) {
  if (streamProbeCache.has(url)) return streamProbeCache.get(url);
  let info = null;
  try {
    const res = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("#EXT-X-STREAM-INF")) {
        const m = await OperantMedia.parseManifest(url, "application/vnd.apple.mpegurl");
        if (m?.type === "hls-master") {
          info = {
            kind: "master",
            videoUrls: (m.segments || []).filter((s) => !s.audioOnly).map((s) => s.url),
            audioUrls: (m.segments || []).map((s) => s.audioUrl).filter(Boolean),
          };
        }
      } else if (text.includes("#EXTM3U")) {
        info = { kind: "media" };
      }
    }
  } catch {
    info = null;
  }
  streamProbeCache.set(url, info);
  return info;
}

// ¿La URL capturada coincide con esta URL candidata? (exacta o por basename,
// los CDNs añaden/tocan query strings entre peticiones).
function streamUrlMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = a.split("?")[0];
  const nb = b.split("?")[0];
  return na === nb || na.endsWith("/" + nb.split("/").pop()) || nb.endsWith("/" + na.split("/").pop());
}

function findItemByUrl(tab, url) {
  for (const it of tab.items) {
    if (streamUrlMatch(it.url, url)) return it;
  }
  return null;
}

async function classifyStreamRelations(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  let changed = false;

  // 1. Masters m3u8: sus variantes son componentes y sus pistas de audio
  //    van a la pestaña de audio.
  const masters = tab.items.filter((i) => i.type === "video" && /\.m3u8/i.test(i.url) && !i._probed);
  for (const it of masters) {
    it._probed = true;
    const info = await probePlaylist(it.url);
    if (info?.kind !== "master") continue;
    changed = true;
    it._isMaster = true;
    for (const vu of info.videoUrls) {
      const comp = findItemByUrl(tab, vu);
      if (comp && comp !== it) {
        comp.component = true;
        changed = true;
      }
    }
    for (const au of info.audioUrls) {
      const track = findItemByUrl(tab, au);
      if (track && track.type !== "audio") {
        track.type = "audio";
        if (track.ext === "m3u8") track.ext = "m4a";
        changed = true;
      }
    }
  }

  // 2. m3u8 media-playlist que ya sabemos variantes/audio por un master
  //    sonado (sin master propio capturado): match por basename contra las
  //    relaciones ya cacheadas.
  const media = tab.items.filter((i) => i.type === "video" && /\.m3u8/i.test(i.url) && !i._probed);
  for (const it of media) {
    it._probed = true;
    const base = it.url.split("?")[0].split("/").pop();
    let matched = false;
    for (const info of streamProbeCache.values()) {
      if (info?.kind !== "master") continue;
      if (info.videoUrls.some((vu) => streamUrlMatch(vu, it.url))) {
        it.component = true;
        matched = true;
        break;
      }
      if (info.audioUrls.some((au) => streamUrlMatch(au, it.url))) {
        it.type = "audio";
        it.ext = "m4a";
        matched = true;
        break;
      }
    }
    if (!matched && base) {
      for (const info of streamProbeCache.values()) {
        if (info?.kind !== "master") continue;
        if (info.videoUrls.some((vu) => vu.split("?")[0].endsWith("/" + base))) {
          it.component = true;
          break;
        }
      }
    }
    changed = true;
  }

  // 3. mp4/m4s pequeños sin clasificar: posibles init/segmentos de pistas.
  //    Parseo real de cajas (genérico): solo-audio → pestaña Audio;
  //    solo-vídeo o muxed diminuto → componente oculto.
  const mp4s = tab.items.filter(
    (i) =>
      i.type === "video" &&
      /\.(mp4|m4s)(?:[?#].*)?$/i.test(i.url) &&
      !i._probedTracks &&
      (i.sizeKB === null || (i.sizeKB > 0 && i.sizeKB < 200))
  );
  for (const it of mp4s.slice(0, 8)) {
    it._probedTracks = true;
    const t = await OperantMedia.trackTypesOf(it.url);
    if (!t) continue;
    if (t.audio && !t.video) {
      it.type = "audio";
      if (!it.ext || it.ext === "mp4") it.ext = "m4a";
      changed = true;
    } else if (t.video && !t.audio) {
      it.component = true;
      changed = true;
    } else if (t.video && t.audio && it.sizeKB !== null && it.sizeKB < 50) {
      it.component = true;
      changed = true;
    }
  }
  return changed;
}

// --- Captura verificada del SW con Referer de la página (anti-hotlink) ---
// Fetch en memoria con Referer inyectado (regla DNR efímera), devuelto como
// bytes + MIME. ÚNICA implementación de fetch con Referer: la usa la descarga
// honesta (swFetchAndDownload) y la captura para fotogramas/portapapeles
// (fetch-blob-data). Lanza el error REAL; nunca silencia fallos.
//
// NOTA SOBRE COOKIES: un fetch del service worker NO puede leer cookies
// HttpOnly (haría falta el permiso `cookies`). Se hace lo que se puede sin
// pedir ese permiso: `credentials: "include"` para que el navegador adjunte
// las cookies que SÍ son adjuntables (mismo origen, o cross-origin con
// SameSite=None; Secure). Cuando el permiso `cookies` ha sido concedido por el
// usuario, dnrAuthHeaders() añade además una cabecera Cookie explícita.
async function swFetchAsDataUrl(url, pageUrl, maxBytes) {
  const ruleId = pageUrl ? await dnrSetAuthRule(url, pageUrl) : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(url, {
      ...(pageUrl ? { referrer: pageUrl, referrerPolicy: "unsafe-url" } : {}),
      credentials: "include",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // El límite se comprueba ANTES de materializar el cuerpo. Antes se hacía
    // `arrayBuffer()` primero y se comparaba después, con lo que un "fallo"
    // de 4 GB ya había consumido 4 GB de RAM del service worker.
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      throw new Error(
        `El medio (${(declared / 1048576).toFixed(0)} MB) supera el límite de captura (${(maxBytes / 1048576).toFixed(0)} MB).`
      );
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(
        `El medio (${(buf.byteLength / 1048576).toFixed(0)} MB) supera el límite de captura (${(maxBytes / 1048576).toFixed(0)} MB).`
      );
    }
    // `new Uint8Array(arrayBuffer)` NO copia: es una vista sobre el mismo
    // búfer. Antes se envolvía dos veces y el pico de memoria era 2x.
    const mime = res.headers.get("content-type") || "application/octet-stream";
    return {
      bytes: new Uint8Array(buf),
      mime,
      fileName: filenameFromResponse(res, url),
    };
  } finally {
    // clearTimeout SIEMPRE, también si el fetch falla por una causa que no sea
    // el abort: antes el temporizador de 120 s se quedaba vivo para siempre en
    // cada fallo de red.
    clearTimeout(timer);
    if (ruleId) dnrClearAuthRule(url);
  }
}

// Uint8Array → data URL por chunks de 32KB (String.fromCharCode.apply con el
// buffer completo revienta por stack overflow — verificado en el proyecto).
function bytesToDataUrl(bytes, mime) {
  const CHUNK = 0x8000;
  let b64 = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return `data:${mime};base64,${btoa(b64)}`;
}

// Descarga VERIFICADA vía el SW: fetch con Referer → verificación de bytes
// (rechazar init segments de fMP4) → data URL → chrome.downloads → estado
// final del gestor. Devuelve { ok: true } o lanza el error real.
async function swFetchAndDownload(url, filename, pageUrl) {
  const { bytes, mime, fileName } = await swFetchAsDataUrl(url, pageUrl, 128 * 1024 * 1024);
  // Defensa ANTI-INIT (CRITERIO SEGURO): solo se rechaza si el archivo TOTAL
  // es diminuto (<50KB) y es un MP4 sin datos (ftyp/moov sin mdat/moof). Un
  // vídeo real pesa MB — su primer fragmento puede tener moov sin mdat
  // todavía; bloquear por los primeros KB daría falsos positivos. Un init
  // segment pesa <1KB.
  //
  // La búsqueda de marcas se hace sobre BYTES (bytesContainAscii). Antes se
  // hacía `String.fromCharCode(...bytes)`, que con un array grande lanza
  // RangeError por límite de argumentos: el "fallo" se producía en el camino
  // que precisamente debía evitarlo.
  if (bytes.byteLength < 50 * 1024) {
    const isInitOnly =
      (bytesContainAscii(bytes, "ftyp") || bytesContainAscii(bytes, "moov")) &&
      !bytesContainAscii(bytes, "mdat") &&
      !bytesContainAscii(bytes, "moof");
    if (isInitOnly) {
      throw new Error("El recurso es metadata de stream (init segment), no un vídeo. Descarga el stream completo (manifiesto) o usa yt-dlp.");
    }
  }
  // Prioridad de nombre: lo que propose el llamador (panel/overlay), después
  // lo que dice Content-Disposition, después el basename de la URL. Todos
  // pasan por el saneador.
  const name = safeDownloadName(filename || fileName, url, "", mime);
  const dataUrl = bytesToDataUrl(bytes, mime);
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename: name, conflictAction: "uniquify" });
  return monitorDownloadId(downloadId);
}

// Revoca un blob URL cuando la descarga que lo consume ha TERMINADO, no cuando
// un temporizador de reloj de pared dice que ya han pasado N segundos. Con
// archivos grandes la escritura sigue en curso cuando ese temporizador dispara
// y Chrome falla con ERR_FILE_NOT_FOUND. Si el estado nunca llega a un final
// terminal, hay un temporizador de seguridad con margen holgado.
function revokeBlobUrlWhenDone(objUrl, downloadId) {
  let settled = false;
  const revoke = () => {
    if (settled) return;
    settled = true;
    try { chrome.downloads.onChanged.removeListener(listener); } catch { /* ya removido */ }
    URL.revokeObjectURL(objUrl);
  };
  const listener = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === "complete" || delta.state.current === "interrupted") revoke();
  };
  chrome.downloads.onChanged.addListener(listener);
  setTimeout(revoke, 30 * 60 * 1000);
}

// Observa el estado final REAL de una descarga del gestor de Chrome.
// Resuelve { ok, bytes } o { ok: false, error } — nunca antes de que la
// descarga haya terminado (complete) o se haya interrumpido.
function monitorDownloadId(id) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { chrome.downloads.onChanged.removeListener(listener); } catch { /* ya removido */ }
      resolve(r);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.search({ id }, (r) => {
          const d = r && r[0];
          finish({ ok: true, bytes: (d && d.fileSize) || 0 });
        });
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.search({ id }, (r) => {
          const d = r && r[0];
          finish({ ok: false, error: `descarga interrumpida (${(d && d.error) || "desconocido"})` });
        });
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // Carrera: el evento pudo dispararse antes de registrar el listener.
    chrome.downloads.search({ id }, (r) => {
      const d = r && r[0];
      if (!d) return finish({ ok: false, error: "la descarga no se pudo iniciar" });
      if (d.state === "complete") finish({ ok: true, bytes: d.fileSize || 0 });
      else if (d.state === "interrupted") finish({ ok: false, error: `descarga interrumpida (${d.error || "desconocido"})` });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "get-state") {
    handleGetState(msg.tabId).then(sendResponse);
    return true; // respuesta asíncrona
  }
  if (msg?.type === "request-scan") {
    requestScan(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg?.type === "get-missing-sizes") {
    // El panel pide re-resolver tamaños pendientes (items con sizeKB null).
    // Responde con los items enriquecidos; el panel re-renderiza al recibirlos.
    (async () => {
      const tab = tabs.get(msg.tabId);
      if (tab) {
        // Limpiar el sizeCache de fallos previos para reintentar de verdad.
        for (const item of tab.items) {
          if (item.sizeKB === null) sizeCache.delete(item.url);
        }
        await enrichMissing(msg.tabId);
      }
      const t2 = tabs.get(msg.tabId);
      sendResponse({ items: t2 ? t2.items : [] });
    })();
    return true; // respuesta asíncrona
  }
  if (msg?.type === "media-updated") {
    // Viene del content script: actualiza estado central y reenvía al panel.
    // Broadcast THROTTLED (300ms): el content script ya agrupa, pero una
    // ráfaga de mensajes no debe serializar el estado completo N veces.
    const tabId = msg.tabId ?? sender.tab?.id ?? 0;
    console.log("[operant-sw] media-updated tabId=", tabId, "items=", msg.items?.length, "senderTab=", sender.tab?.id);
    const tab = ensureTab(tabId);
    const byUrl = new Map(tab.items.map((it) => [it.url.split("#")[0], it]));
    for (const item of msg.items) byUrl.set(item.url.split("#")[0], withSeq(item));
    tab.items = [...byUrl.values()].slice(0, MAX_ITEMS_PER_TAB);
    updateBadge(tabId);
    persistTab(tabId);
    enrichMissing(tabId); // tamaños de items del DOM (antes quedaban en "?")
    if (autoDetect) {
      const now = Date.now();
      if (!mediaBlastAt || now - mediaBlastAt >= 300) {
        mediaBlastAt = now;
        chrome.runtime
          .sendMessage({ type: "state-updated", tabId, items: tab.items })
          .catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "overlay-download") {
    // La decisión de estrategia la toma OperantMedia.classifyDownload (media-core.js),
    // la ÚNICA fuente de verdad — misma lógica que usa el panel. Aquí solo se
    // ejecuta la estrategia resultante (directo / manifiesto→mp4 / yt-dlp).
    let url = msg.url || "";
    // Vídeo blob: (MSE, X/Instagram) sin URL de red en el DOM: el content
    // script no pudo resolver. Buscar en los items capturados por webRequest
    // de esa pestaña una URL de red real (la mejor: directa o manifiesto).
    if (msg.blobOnly || url.startsWith("blob:")) {
      const tabId = msg.tabId ?? sender.tab?.id ?? 0;
      const tab = tabs.get(tabId);
      const candidates = (tab?.items || []).filter((i) => i.source === "network" && i.type === "video" && i.url.startsWith("http"));
      // Descartar INIT SEGMENTS de fMP4 (DASH de X/Twitter, Instagram…):
      // suelen llamarse *init*.mp4 (o .m4s) y pesar < ~50KB — son metadata
      // vacía (solo moov/trak, sin mdat). Elegirlos producía el bug del
      // "vídeo de 786B". Los MANIFIESTOS (m3u8/mpd) siempre son pequeños pero
      // NO son init: el filtro de tamaño solo aplica a URLs de media.
      const isManifest = (u) => /\.(m3u8|mpd)(?:[?#].*)?$/i.test(u);
      const looksLikeInit = (u, sizeKB) =>
        /init/i.test(u) ||
        /(?:^|[\/._-])(?:init|header)(?:[\/._-]|$)/i.test(u) ||
        (!isManifest(u) && Number.isFinite(sizeKB) && sizeKB > 0 && sizeKB < 50);
      const real = candidates.filter((i) => !looksLikeInit(i.url, i.sizeKB));
      // Preferir M3U8 sobre MPD: el motor HLS del navegador descarga m3u8
      // muxed (vídeo+audio) de forma íntegra y verificada, sin host; el MPD
      // de X/Reddit trae audio separado y exige remux externo.
      const isM3u8 = (u) => /\.m3u8(?:[?#].*)?$/i.test(u);
      const isMpd = (u) => /\.mpd(?:[?#].*)?$/i.test(u);
      const manifest = real.find((i) => isM3u8(i.url)) || real.find((i) => isMpd(i.url));
      const direct = real.find((i) => /\.(mp4|webm|mov|mkv)(?:[?#].*)?$/i.test(i.url));
      url = (manifest || direct || real[0] || candidates[0] || { url: "" }).url;
      if (!url) {
        sendResponse({ ok: false, error: "El vídeo no se ha cargado aún (blob: sin stream capturado). Reproduce el vídeo en la página y vuelve a intentarlo." });
        return;
      }
    }
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    const kind = msg.kind || ""; // "video" si viene del botón de vídeo del overlay
    // Nombre SEGURO: lo propone el overlay (a menudo el `alt`/`title` de la
    // página), y pasa por el saneador antes de tocar el sistema de ficheros.
    const pageUrlOfSender = sender.tab?.url || msg.pageUrl || "";
    const filename = safeDownloadName(msg.filename, url, urlExt(url).replace(/^\./, ""));

    // ¿La URL es un MP4 que solo contiene metadata (init segment fMP4)?
    // CRITERIO SEGURO: solo se considera init si el archivo TOTAL es diminuto
    // (<50KB). Un vídeo real pesa MB — su primer fragmento puede tener moov
    // sin mdat todavía, y bloquearlo por los primeros KB daría falsos positivos
    // (el bug "ya no se descarga"). Un init segment de X pesa <1KB.
    async function detectInitOnlyMp4(u) {
      try {
        const res = await fetchWithTimeout(
          u,
          { headers: { Range: "bytes=0-65535" }, cache: "no-store" },
          ENRICH_TIMEOUT_MS
        );
        if (!res.ok && res.status !== 206 && res.status !== 200) return false;
        // Tamaño total conocido: si es >= 50KB, es un archivo real (no init).
        const total = declaredTotalBytes(res);
        if (total >= 50 * 1024) return false;
        const buf = new Uint8Array(await res.arrayBuffer());
        // Búsqueda por BYTES: `String.fromCharCode(...buf)` con 65536
        // argumentos está en el límite y lanza RangeError de forma
        // intermitente según el motor.
        if (!bytesContainAscii(buf, "ftyp") && !bytesContainAscii(buf, "moov")) return false; // no es MP4
        // init segment: tiene moov pero no mdat ni moof (sin datos de media).
        return !bytesContainAscii(buf, "mdat") && !bytesContainAscii(buf, "moof");
      } catch {
        return false; // no se pudo verificar: no bloquear
      }
    }

    // --- Descarga VERIFICADA y honesta ---
    // Nada se responde { ok: true } sin (1) sondear los bytes reales antes de
    // descargar (rechazar páginas HTML de error) y (2) esperar el estado final
    // del gestor de descargas (complete / interrupted). Si el navegador no
    // puede (anti-hotlink, 403), se encadenan los fallbacks ANTES de rendirse,
    // y cada error se reporta con su causa real.
    const attemptBrowserDownload = () =>
      OperantMedia.probeMedia(url).then(async (probe) => {
        if (probe.ok) {
          const verdict = OperantMedia.mediaVerdict(probe);
          if (verdict === "html") {
            throw new Error("El servidor devolvió una página HTML en lugar del medio (protección anti-hotlink o URL expirada).");
          }
          if (verdict === "manifest") {
            // El "directo" era en realidad un manifiesto: procesarlo como tal
            // (el resultado lleva enqueued si acabó en el companion).
            const m = await OperantMedia.parseManifest(url, probe.contentType, probe.bytes);
            if (m) return doManifest(m);
          }
        }
        return detectInitOnlyMp4(url).then((isInit) => {
          if (isInit) throw new Error("init-segment");
          // La descarga directa la hace el gestor de descargas de Chrome, que
          // ya envía las cookies del perfil — pero NO el Referer, que es lo
          // que comprueban la mayoría de los CDN con anti-hotlink. Se mantiene
          // una regla DNR viva durante toda la descarga para cubrir ese hueco,
          // y se retira al terminar. Antes solo se cubría el fetch del SW, que
          // es el camino de reserva: la ruta principal quedaba sin Referer.
          return withDnrAuth(url, pageUrlOfSender, () =>
            chrome.downloads
              .download({ url, filename: filename || undefined, conflictAction: "uniquify" })
              .then((id) => monitorDownloadId(id))
              .then((r) => {
                if (!r.ok) throw new Error(r.error);
                return r;
              })
          );
        });
      });

    const doManifest = async (manifest) => {
      // Manifiesto MEDIA (la URL capturada es la VARIANTE): buscar su master
      // entre los m3u8 capturados de la pestaña — el audio separado vive en
      // el master (#EXT-X-MEDIA). Con mux disponible → companion; sin él,
      // se entrega la variante (la nota de audio honesta la acompaña).
      if (manifest?.type === "hls") {
        const tab = tabs.get(sender.tab?.id ?? 0);
        const candidates = (tab?.items || [])
          .filter((i) => i.type === "video" && /\.m3u8/i.test(i.url) && i.url !== url)
          .map((i) => i.url);
        const found = await OperantMedia.findHlsMaster(url, candidates);
        if (found?.variant?.audioUrl) {
          const port = connectNative();
          if (!port) {
            return { ok: false, error: "Este stream lleva el audio en una pista separada (HLS): para unir vídeo+audio hace falta el companion (operant-host.exe)." };
          }
          port.postMessage({
            type: "ffmpeg-op",
            url: found.variant.url,
            op: "hls-dash",
            options: { audioUrl: found.variant.audioUrl, filename: base },
          });
          return { ok: true, enqueued: true, note: "Descargando vídeo + audio (HLS) y uniéndolos con el companion… El resultado se confirma en el panel." };
        }
        return await swFastHls(url, base, sender.tab?.id ?? null);
      }
      // DASH con vídeo y audio SEPARADOS (X/Reddit/Instagram en mpd): el
      // navegador no puede muxear pistas → host (dash-merge). {ok, enqueued}
      // significa "encolado": el resultado real se reporta al panel.
      if (manifest?.hasSeparateAudio && manifest.segments?.video?.length && manifest.segments?.audio?.length) {
        const bestVideo = manifest.segments.video.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
        const bestAudio = manifest.segments.audio.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
        const port = connectNative();
        if (!port) {
          return { ok: false, error: "Este stream tiene vídeo y audio separados (DASH): para unirlos en un solo archivo hace falta el companion (operant-host.exe)." };
        }
        try {
          // Si el parser DASH generó init + media segments (fMP4 de X), pasar
          // las listas completas al host para que las descargue y concatene.
          port.postMessage({
            type: "ffmpeg-op",
            url: bestVideo.url,
            op: "dash-merge",
            options: {
              videoUrl: bestVideo.url,
              audioUrl: bestAudio.url,
              filename: base,
              videoSegments: buildSegList(bestVideo),
              audioSegments: buildSegList(bestAudio),
            },
          });
          return { ok: true, enqueued: true, note: "Descargando vídeo+audio por separado y uniéndolos con el companion… El resultado se confirma en el panel." };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      // HLS (m3u8, muxed): la vía PRINCIPAL es el motor del navegador
      // (swFastHls): parseo + fetch paralelo + entrega VERIFICADA. No depende
      // del companion y su resultado es comprobable — el check del overlay
      // solo aparece cuando el archivo existe de verdad. El host queda como
      // último recurso (p. ej. motores sin soporte).
      if (/\.m3u8(?:[?#].*)?$/i.test(url)) {
        // Masters con audio SEPARADO (X/Twitter, YouTube Live): todas las
        // variantes vídeo llevan su audio en grupo #EXT-X-MEDIA → sin mux no
        // hay archivo completo; el navegador no puede muxear → companion.
        const videoSegs = (manifest?.segments || []).filter((s) => !s.audioOnly && s.url);
        const needsMux = videoSegs.length > 0 && videoSegs.every((s) => s.audioUrl);
        if (needsMux) {
          const port = connectNative();
          if (!port) {
            return { ok: false, error: "Este stream lleva el audio en una pista separada (HLS): para unir vídeo+audio hace falta el companion (operant-host.exe)." };
          }
          const best = videoSegs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
          try {
            port.postMessage({
              type: "ffmpeg-op",
              url: best.url,
              op: "hls-dash",
              options: { audioUrl: best.audioUrl, filename: base },
            });
            return { ok: true, enqueued: true, note: "Descargando vídeo + audio (HLS) y uniéndolos con el companion… El resultado se confirma en el panel." };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        }
        try {
          return await swFastHls(url, base, sender.tab?.id ?? null);
        } catch (eHls) {
          const port = connectNative();
          if (port) {
            try {
              port.postMessage({ type: "ffmpeg-op", url, op: "hls-dash", options: { filename: base } });
              return { ok: true, enqueued: true, note: `La ruta rápida falló (${String(eHls?.message || eHls)}). Encolado en el companion; el resultado se confirma en el panel.` };
            } catch { /* cae al fetch directo */ }
          }
          throw eHls;
        }
      }
      // Otros manifiestos (mpd sin audio separado…): host si hay; si no, fetch directo.
      const port = connectNative();
      if (port) {
        try {
          port.postMessage({ type: "ffmpeg-op", url, op: "hls-dash", options: { filename: base } });
          return { ok: true, enqueued: true, note: "Encolado en el companion (ffmpeg); el resultado se confirma en el panel." };
        } catch { /* cae al fetch directo */ }
      }
      return doFetchBlob().then(() => ({ ok: true, note: "Descarga completada y verificada." }));
    };
    const doYtdl = () =>
      handleYtdl({ url, filename: base, format: null }).then((r) =>
        r?.ok ? { ok: true, enqueued: true, note: "Enviado a yt-dlp… El resultado se confirma en el panel (requiere acceso a la página; en X suele necesitar las cookies del navegador)." } : r
      );

    OperantMedia.classifyDownload(url, kind).then(async (c) => {
      try {
        if (c.strategy === "manifest") {
          sendResponse(await doManifest(c.manifest));
          return;
        }
        if (c.strategy === "ytdl") {
          sendResponse(await doYtdl());
          return;
        }
        // direct | unknown: descarga verificada con cadena de fallback honesta.
        try {
          const r = await attemptBrowserDownload();
          sendResponse(
            r && r.enqueued
              ? r
              : { ok: true, note: `Descarga completada y verificada (${formatBytesKB(r.bytes)}).` }
          );
        } catch (e1) {
          const m1 = String(e1?.message || e1);
          if (/init-segment/i.test(m1)) {
            sendResponse(await doYtdl());
            return;
          }
          // El navegador no pudo (403 / anti-hotlink / URL con cookie de sesión):
          // capturar con el Referer real de la página antes de rendirse.
          try {
            await swFetchAndDownload(url, filename, sender.tab?.url || "");
            sendResponse({ ok: true, note: "Descarga completada vía el navegador (con Referer de la página)." });
          } catch (e2) {
            const m2 = String(e2?.message || e2);
            if (/init segment|metadata de stream/i.test(m2)) {
              sendResponse(await doYtdl());
              return;
            }
            // Último recurso para vídeo y recursos sin firma: yt-dlp.
            if (kind === "video" || c.strategy === "unknown") {
              sendResponse(await doYtdl());
              return;
            }
            sendResponse({ ok: false, error: m2 || m1 });
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    });
    return true;

    // Fetch+blob del manifiesto (fallback sin host nativo).
    async function doFetchBlob() {
      // Se reutiliza swFetchAsDataUrl: mismo|Referer/credenciales, mismo
      // límite de bytes comprobado ANTES de materializar, y nombre saneado a
      // partir de Content-Disposition cuando el servidor lo propone.
      const { bytes, mime, fileName } = await swFetchAsDataUrl(url, pageUrlOfSender, 128 * 1024 * 1024);
      if (bytes.byteLength === 0) throw new Error("El servidor no devolvió datos");
      const objUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const name = safeDownloadName(filename || fileName, url, "", mime);
      const id = await chrome.downloads.download({ url: objUrl, filename: name, conflictAction: "uniquify" });
      const r = await monitorDownloadId(id);
      // El blob URL se revoca DESPUÉS de que la escritura termine, no con un
      // temporizador de reloj de pared iniciado antes: con archivos grandes la
      // escritura sigue viva cuando el temporizador dispara y Chrome falla con
      // ERR_FILE_NOT_FOUND. Un listener de descargas es el que dice "ya está".
      revokeBlobUrlWhenDone(objUrl, id);
      if (!r.ok) throw new Error(r.error);
      return r;
    }
  }
  if (msg?.type === "overlay-download-blob") {
    // Blob capturado DESDE EL CONTEXTO DE LA PÁGINA: el content script hizo
    // `fetch(url, {credentials:"include"})` con la sesión real del sitio
    // (cookies HttpOnly incluidas, porque las adjunta el navegador para el
    // origen de la página) y reenvía los bytes. El SW de MV3 NO tiene
    // URL.createObjectURL, así que se entrega por data URL desde aquí.
    // Atajo honesto: un data URL listo (p.ej. fotograma capturado) se
    // descarga directamente — sin reconstrucción ambigua de bytes.
    if (typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:")) {
      const name = safeDownloadName(msg.filename, "", "png");
      (async () => {
        try {
          const id = await chrome.downloads.download({ url: msg.dataUrl, filename: name, conflictAction: "uniquify" });
          sendResponse(await monitorDownloadId(id));
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    let data = msg.data;
    if (!data) {
      sendResponse({ ok: false, error: "Sin datos" });
      return;
    }
    // El content script envía un array de números plano (determinista).
    // Se descarga AQUÍ (el SW), con data URL chunked — NO se reenvía al panel:
    // chrome.runtime.sendMessage no serializa binarios grandes (verificado:
    // ArrayBuffer llega {}, array plano revienta, Uint8Array >64MB no
    // serializa). El SW de MV3 no tiene URL.createObjectURL, así que el data
    // URL chunked es la única vía.
    let bytes;
    if (Array.isArray(data)) {
      bytes = Uint8Array.from(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      try {
        bytes = Uint8Array.from(Object.values(data));
      } catch {
        sendResponse({ ok: false, error: "Datos no válidos" });
        return;
      }
    }
    const mime = msg.mime || "video/mp4";
    const name = safeDownloadName(msg.filename, "", "", mime);
    if (bytes.length > 128 * 1024 * 1024) {
      sendResponse({ ok: false, error: `El blob (${(bytes.length / 1048576).toFixed(0)} MB) supera el límite de entrega (128 MB). Descárgalo desde el panel (cola por chunks).` });
      return;
    }
    (async () => {
      try {
        const dataUrl = bytesToDataUrl(bytes, mime);
        await chrome.downloads.download({ url: dataUrl, filename: name, conflictAction: "uniquify" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg?.type === "sw-fetch-blob") {
    // Nivel A del fallback anti-hotlink (GENÉRICO): el SW hace el fetch (sin
    // CORS con <all_urls>) con el Referer REAL de la página inyectado por una
    // regla DNR EFÍMERA por descarga. Resuelve servidores cross-origin que
    // responden sin cabeceras permisivas donde el content script muere por CORS.
    // La implementación es swFetchAndDownload (verificación de bytes y estado
    // final incluidos) — la misma que usa la descarga honesta del overlay.
    const { url, filename } = msg;
    const pageUrl = msg.pageUrl || sender.tab?.url || "";
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    swFetchAndDownload(url, filename, pageUrl).then(
      (r) => sendResponse(r),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true; // respuesta asíncrona
  }
  if (msg?.type === "fetch-blob-data") {
    // Devuelve el recurso como data URL al llamador (overlay/panel) para
    // operaciones LOCALES: captura de fotogramas y copiar al portapapeles en
    // CDNs cross-origin cuyo canvas queda contaminado (CORS). Límite 64MB:
    // es captura de medios puntuales, no descargas grandes.
    const url = msg.url || "";
    const pageUrl = msg.pageUrl || sender.tab?.url || "";
    if (!/^https?:/.test(url)) {
      sendResponse({ ok: false, error: "URL no válida para captura" });
      return;
    }
    swFetchAsDataUrl(url, pageUrl, 64 * 1024 * 1024).then(
      ({ bytes, mime }) => sendResponse({ ok: true, dataUrl: bytesToDataUrl(bytes, mime), size: bytes.byteLength }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true; // respuesta asíncrona
  }
  if (msg?.type === "capture-in-page") {
    // Fallback anti-hotlink: el panel pide capturar el recurso DESDE la página
    // (con cookies + Referer de sesión). Se reenvía al content script del tab
    // (frame 0 o, si no responde, cualquier frame vivo). La respuesta llega
    // cuando el blob ya se entregó al panel vía overlay-download-blob.
    const { url, filename, tabId } = msg;
    if (!url || !tabId) {
      sendResponse({ ok: false, error: "Faltan url/tabId" });
      return;
    }
    (async () => {
      try {
        let target = { frameId: 0 };
        try {
          await chrome.tabs.sendMessage(tabId, { type: "ping" });
        } catch {
          // Frame principal sin content script (o navegó): probar los frames.
          const frames = await chrome.webNavigation.getAllFrames(tabId);
          const alive = frames?.find((f) => f.frameId !== 0);
          if (!alive) throw new Error("No hay content script en esta pestaña");
          target = { frameId: alive.frameId };
          await chrome.tabs.sendMessage(tabId, { type: "ping" }, target);
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: "capture-in-page", url, filename }, target);
        sendResponse(res || { ok: false, error: "Sin respuesta del content script" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg?.type === "overlay-download-audio") {
    // Extraer SOLO el audio, con VERIFICACIÓN PREVIA y honestidad:
    //   - blob: sin URL de red → error honesto (el host no puede leer blobs).
    //   - Vídeo directo: se comprueba la pista de audio REAL (cajas MP4 hdlr
    //     "soun" / CodecID WebM). Los GIF de X son MP4 mudos: no se encola
    //     una extracción que solo puede producir un archivo sin sentido.
    //   - Manifiesto/plataforma: yt-dlp -x (bestaudio) decide el audio real.
    // {ok:true} significa "encolado en el procesador local", NUNCA "terminado".
    const url = msg.url || "";
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    if (url.startsWith("blob:")) {
      sendResponse({ ok: false, error: "El vídeo está en memoria (blob:). Reprodúcelo para que se capture el stream y vuelve a intentarlo." });
      return;
    }
    const port = connectNative();
    if (!port) {
      sendResponse({ ok: false, error: "El host nativo no está instalado (necesario para extraer audio)." });
      return;
    }
    const isDirectVideo = /\.(mp4|webm|mov|mkv|m4v|ogv|3gp)(?:[?#].*)?$/i.test(url);
    if (isDirectVideo) {
      // IIFE async: el listener es síncrono; la verificación de pista de
      // audio es asíncrona → respuesta diferida (return true más abajo).
      (async () => {
        try {
          const audio = await OperantMedia.hasAudioTrack(url);
          if (audio === false) {
            sendResponse({ ok: false, error: "Este medio NO tiene pista de audio (es un GIF o un vídeo mudo). No hay audio que extraer." });
            return;
          }
          port.postMessage({ type: "ffmpeg-op", url, op: "extract-mp3", options: {} });
          sendResponse({
            ok: true,
            note: audio === true
              ? "Extrayendo audio con ffmpeg del host…"
              : "Extrayendo audio con ffmpeg (no se pudo verificar la pista de audio; si el vídeo es mudo, el host lo reportará).",
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true; // respuesta asíncrona
    }
    try {
      port.postMessage({ type: "ytdl", url, filename: msg.filename || "", format: "bestaudio/best" });
      sendResponse({ ok: true, note: "Extrayendo audio con yt-dlp (bestaudio)…" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return;
  }
  if (msg?.type === "overlay-download-gif-video") {
    // GIF como vídeo (webm): lo convierte el host nativo con ffmpeg.
    // Guard honesto: un blob: de la página no es accesible para el host.
    const url = msg.url || "";
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    if (url.startsWith("blob:")) {
      sendResponse({ ok: false, error: "El GIF está en memoria (blob:). Reprodúcelo para que se capture el stream y vuelve a intentarlo." });
      return;
    }
    const port = connectNative();
    if (!port) {
      sendResponse({ ok: false, error: "El host nativo no está instalado (necesario para convertir GIF a vídeo)." });
      return;
    }
    try {
      port.postMessage({ type: "ffmpeg-op", url, op: "convert-webm", options: {} });
      sendResponse({ ok: true, note: "Convirtiendo GIF a vídeo con ffmpeg del host…" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return;
  }
  if (msg?.type === "set-auto") {
    autoDetect = !!msg.value;
    chrome.storage.local.set({ autoDetect });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "scan-progress") {
    // Progreso real del content script -> panel (barra "Analizando X de Y").
    chrome.runtime
      .sendMessage({
        type: "scan-progress",
        tabId: sender.tab?.id,
        done: msg.done,
        total: msg.total,
        phase: msg.phase,
        found: msg.found,
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "content-ready") {
    // El content script se acaba de inyectar: reenviarle los streams capturados
    // por webRequest antes de su inyección (evita perder m3u8/mpd tempranos).
    const tabId = sender.tab?.id;
    if (tabId != null) {
      const net = (tabs.get(tabId)?.items || []).filter((i) => i.source === "network");
      if (net.length) {
        chrome.tabs.sendMessage(tabId, { type: "network-media", items: net }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "set-dnr-referer") {
    // El panel pide crear la regla DNR efímera que inyecta el Referer de la
    // página para las peticiones del propio SW (y de las páginas de extensión,
    // mismo origin). La usa la cola por chunks del panel para descargar
    // archivos grandes con protección de cabecera Referer.
    const { url, pageUrl } = msg;
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    dnrSetAuthRule(url, pageUrl || "")
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // respuesta asíncrona
  }
  if (msg?.type === "clear-dnr-referer") {
    if (msg.url) dnrClearAuthRule(msg.url);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "set-dnr-referer-host") {
    // El panel crea una regla DNR por HOST antes de descargar los segmentos de
    // un m3u8 (ruta rápida): una sola regla cubre todos los segmentos del CDN.
    const { host, pageUrl } = msg;
    if (!host || !pageUrl) {
      sendResponse({ ok: false, error: "Faltan host/pageUrl" });
      return;
    }
    dnrSetRefererHostRule(host, pageUrl).then((ruleId) => sendResponse({ ok: !!ruleId, ruleId }));
    return true; // respuesta asíncrona
  }
  if (msg?.type === "clear-dnr-referer-host") {
    if (msg.host) dnrClearRefererHostRule(msg.host);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "open-tab") {
    // Abre una URL en una pestaña nueva (usado por la búsqueda inversa).
    if (msg.url && /^https?:/.test(msg.url)) {
      chrome.tabs.create({ url: msg.url }).catch(() => {});
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "URL no válida" });
    }
    return;
  }
  if (msg?.type === "auth-permission-changed") {
    // El panel acaba de conceder (o revocar) el permiso opcional `cookies`.
    // Se invalida el estado cacheado para que la siguiente regla DNR incluya
    // la cabecera Cookie, y se retiran las reglas vivas que se instalaron sin
    // ella: si no, el Referer se iría solo y la descarga de un recurso
    // autenticado seguiría fallando.
    (async () => {
      cookiesPermGranted = await hasCookiesPermission();
      const stale = [...dnrAuthRules.keys()];
      for (const key of stale) await dnrRemoveAuthRule(key);
      sendResponse({ ok: true, cookies: cookiesPermGranted });
    })();
    return true;
  }
  if (msg?.type === "upload-tmp") {
    // Sube un blob (frame capturado / imagen local) a LITTERBOX (catbox
    // temporal, expira en 1h) para la búsqueda inversa. Se hace AQUÍ (SW), no
    // en el content script: el fetch desde la página muere por CORS/CSP
    // ("failed to fetch"), mientras que el SW con <all_urls> no tiene CORS.
    // El content script envía el PNG como base64 (lo único que serializa de
    // forma fiable content->SW en MV3).
    (async () => {
      try {
        if (typeof msg.data !== "string" || !msg.data) throw new Error("Sin datos de imagen");
        const b64 = msg.data.replace(/^data:[^,]+,/, "");
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (!bytes.byteLength) throw new Error("Sin datos de imagen");
        const mime = msg.mime || "image/png";
        const name = msg.filename || "frame.png";
        // Tope de 32MB: Litterbox acepta hasta 1GB, pero un frame es ~1MB y
        // no tiene sentido subir más (la API de subida es para frames).
        if (bytes.byteLength > 32 * 1024 * 1024) {
          throw new Error(`La imagen (${(bytes.byteLength / 1048576).toFixed(1)} MB) es demasiado grande para subirla (máx. 32 MB).`);
        }
        const blob = new Blob([bytes], { type: mime });
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("time", "1h"); // TTL mínimo de Litterbox (1h); el frame se consume en segundos
        form.append("fileToUpload", blob, name);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
          method: "POST",
          body: form,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        if (!res.ok) throw new Error(`Litterbox respondió HTTP ${res.status}`);
        const url = text.trim();
        if (!/^https?:\/\//.test(url)) throw new Error("Litterbox no devolvió una URL válida");
        sendResponse({ ok: true, url });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // respuesta asíncrona
  }
  if (msg?.type === "native-healthcheck") {
    nativeHealthcheck().then(sendResponse);
    return true;
  }
  if (msg?.type === "native-tools-status") {
    // Pide al host refrescar la cache de versiones; el estado llega por broadcast.
    const port = connectNative();
    if (port) {
      try {
        port.postMessage({ type: "check-updates" });
      } catch {
        /* host caido: se reporta con el estado cacheado */
      }
    }
    sendResponse({ status: nativeStatus });
    return;
  }
  if (msg?.type === "native-tool-action") {
    sendResponse(sendNativeToolAction(msg.action, msg.tool));
    return;
  }
  if (msg?.type === "ytdl-download") {
    handleYtdl(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === "record-start") {
    const port = connectNative();
    if (!port) {
      sendResponse({ ok: false, error: "El host nativo no está instalado. Abre Herramientas e instálalo." });
      return;
    }
    recSession = { tabId: msg.tabId, session: null, filename: null };
    port.postMessage({ type: "rec-begin" });
    chrome.tabs.sendMessage(
      msg.tabId,
      { type: "rec-start" },
      { frameId: 0 },
      (r) => {
        const err = chrome.runtime.lastError;
        if (err || !r?.ok || r?.installed === false) {
          recFail(
            r?.installed === false
              ? "La grabación no está disponible en este navegador o página (hook MSE no activo)."
              : "No se pudo iniciar la grabación en la pestaña activa."
          );
        }
      }
    );
    recBroadcast({ state: "starting" });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "record-stop") {
    if (!recSession) {
      sendResponse({ ok: false, error: "No hay grabación en curso." });
      return;
    }
    chrome.tabs.get(recSession.tabId, (tab) => {
      if (recSession) recSession.filename = (tab?.title || "grabacion").slice(0, 120);
      chrome.tabs.sendMessage(recSession.tabId, { type: "rec-stop" }).catch(() => {});
    });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "rec-relay") {
    // Datos y eventos del recorder (MAIN world) llegados vía content script.
    const p = msg.payload || {};
    if (p.type === "started" && p.drm) {
      // Honestidad inmediata: la página usa EME/DRM — la grabación interna
      // no puede capturar contenido cifrado. Fallar la sesión ya.
      recFail(p.error || "Esta página usa DRM (EME): la grabación interna no puede capturar contenido cifrado.");
      return;
    }
    if (!recSession || p.type === "started") return;
    if (p.type === "stats") {
      recBroadcast({ state: "recording", bytes: p.bytes, segments: p.segments, sources: p.sources });
    } else if (p.type === "track-chunk") {
      const port = connectNative();
      if (port && recSession.session) {
        port.postMessage({ type: "rec-append", session: recSession.session, track: p.track, data: p.data });
      }
    } else if (p.type === "stopped") {
      const session = recSession;
      const port = connectNative();
      chrome.tabs.get(session.tabId, (tab) => {
        const filename = (tab?.title || "grabacion").slice(0, 120);
        if (port && session.session) {
          port.postMessage({ type: "rec-end", session: session.session, filename });
          recBroadcast({ state: "assembling" });
        } else {
          recFail(p.error || "La grabación terminó sin sesión del host nativo.");
        }
      });
    } else if (p.type === "cancelled") {
      const port = connectNative();
      if (port && recSession.session) port.postMessage({ type: "rec-cancel", session: recSession.session });
      recSession = null;
      recBroadcast({ state: "idle" });
    }
    return;
  }
});

async function handleYtdl(msg) {
  const port = connectNative();
  if (!port) {
    return { ok: false, error: "El host nativo no está instalado. Descarga operant-host.exe desde la página de Releases del repositorio y ejecútalo con doble clic." };
  }
  try {
    port.postMessage({ type: "ytdl", url: msg.url, filename: msg.filename, format: msg.format || null });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// --- Modo grabación: captura de buffers MSE del reproductor ---
// El recorder-main.js (mundo MAIN, document_start) captura appendBuffer; los
// datos llegan al SW vía content script y se pasan al host tal cual
// (passthrough sin acumular: el host los escribe a disco en su bucle
// principal, que preserva el orden). El ffmpeg final corre en el host.
let recSession = null; // { tabId, session, filename } | null

function recBroadcast(patch) {
  chrome.runtime.sendMessage({ type: "rec", ...patch }).catch(() => {});
}

function recFail(message) {
  const session = recSession?.session || null;
  if (session) {
    const port = connectNative();
    port?.postMessage({ type: "rec-cancel", session });
  }
  recSession = null;
  recBroadcast({ state: "error", message });
}

// --- Ruta rápida HLS en el SW (fallback del overlay sin host nativo) ---
// Ejecuta el MISMO motor hls-fast.js que el panel. Entrega por data URL
// chunked (el SW de MV3 no tiene URL.createObjectURL) con el tope de 128 MB ya
// establecido en el proyecto. El progreso se difunde al panel si está abierto.
async function swFastHls(url, filename, tabId) {
  let pageUrl = "";
  try {
    if (tabId != null) pageUrl = (await chrome.tabs.get(tabId))?.url || "";
  } catch {
    pageUrl = ""; // pestaña cerrada mientras se descargaba
  }
  const hostRules = new Set();
  try {
    const result = await HLSFast.downloadHls({
      url,
      concurrency: 6,
      allowLive: false, // sin botón de parada en el SW: un live no debe colgarse aquí
      requireAudio: true, // variante muda (audio separado) → error honesto, no vídeo sin sonido
      beforeFetch: async (segUrl) => {
        try {
          const host = new URL(segUrl).hostname;
          if (pageUrl && /^https?:/.test(segUrl) && !hostRules.has(host)) {
            hostRules.add(host);
            await dnrSetRefererHostRule(host, pageUrl);
          }
        } catch {
          /* sin regla por host: el fetch del SW con <all_urls> suele bastar */
        }
      },
      onProgress: (done, total) => {
        if (total > 0) {
          chrome.runtime.sendMessage({ type: "fast-progress", done, total, name: filename }).catch(() => {});
        }
      },
    });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    if (bytes.length > 128 * 1024 * 1024) {
      throw new Error(
        `El vídeo (${(bytes.length / 1048576).toFixed(0)} MB) supera el límite de entrega por data URL (128 MB). Abre el panel y usa la ruta rápida allí (cola sin ese límite).`
      );
    }
    const mime = result.kind === "ts" ? "video/mp2t" : "video/mp4";
    // Nombre de archivo: los manifiestos suelen llamarse playlist/master/
    // dynamic — con nombre genérico se usa el TÍTULO de la pestaña (genérico
    // para cualquier web, sin listas de sitios). El título lo controla la
    // página, así que pasa por el saneador como cualquier otro nombre.
    let baseName = filename || urlBasename(url) || "video";
    if (/^(playlist|master|index|manifest|dynamic)$/i.test(baseName.replace(/\.(m3u8|mpd)$/i, ""))) {
      try {
        if (tabId != null) {
          const t = await chrome.tabs.get(tabId);
          if (t?.title) baseName = String(t.title).slice(0, 120);
        }
      } catch {
        /* pestaña cerrada mientras se descargaba */
      }
    }
    const name = safeDownloadName(
      baseName.replace(/\.(m3u8|mpd)$/i, ""),
      url,
      result.kind === "ts" ? "ts" : "mp4"
    );
    const dataUrl = bytesToDataUrl(bytes, mime);
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename: name, conflictAction: "uniquify" });
    const delivered = await monitorDownloadId(downloadId); // honesto hasta el final
    if (!delivered.ok) throw new Error(delivered.error);
    const mb = (result.bytes / 1048576).toFixed(1);
    // Verificación honesta de pista de audio (las cajas moov/trak van al
    // principio, así que basta con mirar la cabeza).
    //
    // Solo tiene sentido en fMP4: en MPEG-TS no existe la caja `hdlr`, luego el
    // test era siempre falso y además sería imposible. Antes la comprobaba para
    // los dos formatos, así que TODA descarga TS avisaba de "sin pista de
    // audio" aunque fuera un stream normal con sonido. Y el `...bytes.subarray`
    // de 3 MB lanzaba RangeError por límite de argumentos, es decir, después
    // de que la descarga ya se hubiera entregado: el usuario veía "falló" en
    // una descarga completada.
    const noAudio =
      result.kind !== "ts" && !bytesContainAscii(bytes, "soun", 3 * 1024 * 1024);
    return {
      ok: true,
      note: `Descarga completada y verificada: ${result.segments} segmentos, ${mb} MB.` +
        (noAudio ? " ATENCIÓN: sin pista de audio (variante con audio separado — se necesita el companion para unirlo)." : ""),
    };
  } finally {
    // Reglas DNR efímeras: limpiar SIEMPRE (éxito, fallo o cancelación).
    for (const host of hostRules) dnrClearRefererHostRule(host);
    // Los tokens AES expiran: no arrastrar claves entre descargas.
    HLSFast.clearKeyCache();
  }
}

// Nota: la cola de descargas por chunks vive en el PANEL (panel.js), no en el SW:
// los service workers de MV3 no tienen URL.createObjectURL, necesario para
// entregar el blob ensamblado a chrome.downloads.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ffmpeg-op") {
    const port = connectNative();
    if (!port) {
      sendResponse({ ok: false, error: "El host nativo no está instalado." });
      return;
    }
    try {
      port.postMessage({ type: "ffmpeg-op", url: msg.url, op: msg.op, options: msg.options || {} });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return;
  }
  if (msg?.type === "ytdl-list-formats") {
    const port = connectNative();
    if (!port) {
      sendResponse({ ok: false, error: "El host nativo no está instalado." });
      return;
    }
    try {
      port.postMessage({ type: "ytdl-list-formats", url: msg.url });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return;
  }
});

// --- Auto-reparación de content scripts huérfanos ---
// Tras recargar la extensión, las pestañas abiertas conservan content scripts
// de la generación anterior (canal chrome.runtime muerto → "Extension
// context invalidated" en cada interacción). Cuando el SW toca una pestaña
// (panel, escaneo) y esta no responde, re-inyecta los content scripts de la
// generación actual: la pestaña se auto-repara sin recargar la página.
async function tabAlive(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch {
    return false;
  }
}

async function reinjectContentScripts(tabId) {
  if (!chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared/icons.js", "shared/dl-indicator.js", "content.js"],
    });
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["recorder-main.js"],
      });
    } catch {
      /* MAIN world no inyectable en algunas páginas: la parte aislada ya está */
    }
    return true;
  } catch {
    return false; // páginas no inyectables (chrome://, webstore, PDF viewer…)
  }
}

async function handleGetState(tabId) {
  const tab = ensureTab(tabId);
  try {
    const stored = await chrome.storage.session.get(keyFor(tabId));
    if (stored[keyFor(tabId)] && tab.items.length === 0) {
      tab.items = stored[keyFor(tabId)];
      // El contador de seq es de proceso: tras un reinicio del SW debe
      // continuar por encima del máximo restaurado (sin colisiones).
      for (const it of tab.items) {
        if (typeof it.seq === "number" && it.seq >= seqCounter) seqCounter = it.seq + 1;
      }
    }
  } catch {
    /* sin persistencia */
  }
  // Pide un escaneo fresco al content script (si existe) y mezcla.
  // RESPUESTA INMEDIATA: el estado actual ya es fiel. Esperar aquí a la
  // enriqueción de tamaños (GET por item; cientos en páginas grandes) era la
  // causa del ciclo de carga infinito del panel. La enriqueción continúa en
  // background y su progreso llega por broadcasts state-updated (throttled).
  // Antes de escanear: si la pestaña tiene un content script huérfano
  // (extensión recargada), se re-inyecta — auto-reparación transparente.
  try {
    if (!(await tabAlive(tabId))) await reinjectContentScripts(tabId);
    const res = await chrome.tabs.sendMessage(tabId, { type: "scan" });
    if (res?.items) {
      const byUrl = new Map(tab.items.map((it) => [it.url.split("#")[0], it]));
      for (const item of res.items) byUrl.set(item.url.split("#")[0], withSeq(item));
      tab.items = [...byUrl.values()].slice(0, MAX_ITEMS_PER_TAB);
    }
    updateBadge(tabId);
    persistTab(tabId);
    enrichMissing(tabId); // sin await: tamaños en vivo vía broadcast
    return { items: tab.items, reachable: true };
  } catch {
    return { items: tab.items, reachable: false };
  }
}

async function requestScan(tabId) {
  try {
    if (!(await tabAlive(tabId))) await reinjectContentScripts(tabId);
    // force-rescan (no "scan"): re-ejecuta fullScan para que el progreso real
    // del barrido de estilos fluya al panel con el botón «Actualizar».
    const res = await chrome.tabs.sendMessage(tabId, { type: "force-rescan" });
    const tab = ensureTab(tabId);
    if (res?.items) {
      const byUrl = new Map(tab.items.map((it) => [it.url.split("#")[0], it]));
      for (const item of res.items) byUrl.set(item.url.split("#")[0], withSeq(item));
      tab.items = [...byUrl.values()].slice(0, MAX_ITEMS_PER_TAB);
    }
    updateBadge(tabId);
    persistTab(tabId);
    enrichMissing(tabId); // sin await: progreso en vivo, respuesta inmediata
    return { items: tab.items };
  } catch {
    return { items: ensureTab(tabId).items };
  }
}

// --- Fase 4: Native Messaging (yt-dlp / ffmpeg auto-gestionados por el host) ---
let nativePort = null;
let nativeStatus = { installed: false, checkedAt: 0, tools: null };

function connectNative() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener((msg) => {
      if (msg?.type === "pong" || msg?.type === "tools-status" || msg?.type === "tool-uninstalled") {
        nativeStatus = {
          installed: true,
          checkedAt: Date.now(),
          tools: msg.tools || null,
        };
        chrome.storage.local.set({ nativeStatus });
      }
      if (msg?.type === "rec-beginned" && recSession) {
        recSession.session = msg.session; // ya se pueden enviar chunks
      }
      if (msg?.type === "rec-error" && recSession) {
        recFail(msg.message || "Error del host nativo durante la grabación.");
      }
      // El mensaje se envuelve (no se hace spread): el spread machacaba el
      // tipo con el del host y los progresos/formatos nunca llegaban al panel.
      chrome.runtime.sendMessage({ type: "native", msg }).catch(() => {});
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
    });
  } catch {
    nativePort = null;
  }
  return nativePort;
}

async function nativeHealthcheck() {
  // Cache de 30 s para no abrir/cerrar el proceso nativo a cada rato.
  if (Date.now() - nativeStatus.checkedAt < 30000) {
    return { status: nativeStatus };
  }
  const port = connectNative();
  if (!port) {
    nativeStatus = { installed: false, checkedAt: Date.now(), tools: null };
    return { status: nativeStatus };
  }
  try {
    port.postMessage({ type: "ping" });
  } catch {
    nativeStatus = { installed: false, checkedAt: Date.now(), tools: null };
    return { status: nativeStatus };
  }
  return { status: nativeStatus };
}

function sendNativeToolAction(action, tool) {
  const port = connectNative();
  if (!port) {
    return { ok: false, error: "El host nativo no está instalado. Descarga operant-host.exe desde la página de Releases del repositorio y ejecútalo con doble clic." };
  }
  try {
    port.postMessage({ type: action, tool });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
