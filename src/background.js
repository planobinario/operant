// background.js — Service worker de Operant.
// Responsabilidades:
//   1. Abrir el side panel al hacer clic en el icono (chrome.sidePanel).
//   2. Capturar streams de red con webRequest (m3u8, mpd, mp4… que no están en el DOM).
//   3. Centralizar el estado por pestaña y enriquecer items con tamaño (HEAD).
//   4. Comunicarse con el host nativo (yt-dlp/ffmpeg) vía Native Messaging.

// ÚNICA FUENTE DE VERDAD de detección/descarga (compartida con el panel).
import { NTMedia } from "./shared/media-core.js";
// Ruta rápida HLS 100% en navegador (mismo motor que ejecuta el panel):
// parseo m3u8 + fetch paralelo + AES-128 (WebCrypto) + concat fMP4/TS.
import { HLSFast } from "./shared/hls-fast.js";

const NATIVE_HOST = "com.operant.native_host";
const MAX_ITEMS_PER_TAB = 4000;

// --- Anti-hotlink genérico (no hardcodeado por sitio) ---
// El fetch DESDE la página a un CDN cross-origin que NO manda
// Access-Control-Allow-Origin muere por CORS, y el fetch del SW sin Referer da
// 403/410. Solución de raíz: el SW hace el fetch (sin CORS con <all_urls>) y
// declarativeNetRequest le inyecta el Referer REAL de la página, en una regla
// EFÍMERA por descarga (id derivado de la URL, se elimina al terminar). Así
// funciona con cualquier CDN con anti-hotlink sin lista de sitios.
const DNR_RULE_BASE = 7000; // rango 7001..7999 (hasta 999 reglas simultáneas)

// ID determinista y estable por URL (evita colisiones entre descargas).
function dnrRuleIdFor(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return DNR_RULE_BASE + 1 + (h % 999);
}

async function dnrSetRefererRule(url, referer) {
  if (!chrome.declarativeNetRequest) return;
  const id = dnrRuleIdFor(url);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Referer", operation: "set", value: referer }],
          },
          condition: {
            initiatorDomains: [chrome.runtime.id], // solo peticiones del propio SW
            resourceTypes: ["xmlhttprequest", "media", "other"],
            urlFilter: url,
          },
        },
      ],
    });
    return id;
  } catch (e) {
    console.log(`[operant-sw] DNR rule add failed: ${String(e?.message || e)}`);
    return null;
  }
}

async function dnrClearRefererRule(url) {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [dnrRuleIdFor(url)] });
  } catch {
    /* no-op */
  }
}

// --- Anti-hotlink POR HOST (ruta rápida HLS) ---
// Un m3u8 puede tener cientos de segmentos: crear una regla DNR por segmento
// revientaría el límite (~999 reglas simultáneas) y sería O(n) mensajes. Una
// regla POR HOST con urlFilter "||host" cubre todos los segmentos del mismo
// CDN. Rango de ids propio (6800-6999) para no colisionar con las reglas por
// URL (7000+) al limpiar.
const DNR_HOST_RULE_BASE = 6800;

function dnrHostRuleIdFor(hostname) {
  let h = 0;
  for (let i = 0; i < hostname.length; i++) h = (h * 31 + hostname.charCodeAt(i)) >>> 0;
  return DNR_HOST_RULE_BASE + 1 + (h % 199);
}

async function dnrSetRefererHostRule(hostname, referer) {
  if (!chrome.declarativeNetRequest || !hostname || !referer) return null;
  const id = dnrHostRuleIdFor(hostname);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Referer", operation: "set", value: referer }],
          },
          condition: {
            initiatorDomains: [chrome.runtime.id], // solo peticiones del propio SW/panel
            resourceTypes: ["xmlhttprequest", "media", "other"],
            urlFilter: `||${hostname}`,
          },
        },
      ],
    });
    return id;
  } catch (e) {
    console.log(`[operant-sw] DNR host rule add failed: ${String(e?.message || e)}`);
    return null;
  }
}

async function dnrClearRefererHostRule(hostname) {
  if (!chrome.declarativeNetRequest || !hostname) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [dnrHostRuleIdFor(hostname)] });
  } catch {
    /* no-op */
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
chrome.runtime.onInstalled.addListener(() => {
  // Clic en el icono => abre el panel lateral.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.storage.local.get(["autoDetect"], (data) => {
    if (data.autoDetect === undefined) chrome.storage.local.set({ autoDetect: true });
  });
});

// Badge con el nº de medios de la pestaña activa.
chrome.action.setBadgeBackgroundColor({ color: "#3f3f46" }).catch(() => {});

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

function urlBasename(url) {
  try {
    const p = new URL(url).pathname.split("/").filter(Boolean).pop();
    return p ? decodeURIComponent(p) : "";
  } catch {
    return "";
  }
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

    const item = {
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
    };
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

// --- Enriquecimiento: tamaño estimado vía HEAD ---
// Orden de técnicas para obtener el tamaño REAL (de más fiable a menos):
//   0. Performance Resource Timing (sizeBytes del content script): el navegador
//      ya cargó el recurso y registró encodedBodySize — sin petición extra.
//   1. GET real + blob.size: cuenta los bytes recibidos, preciso aunque el
//      servidor no mande Content-Length (gstatic/Google Images funcionan así).
//   1.5. GET con Referer vía DNR (anti-hotlink): muchos CDNs (erome) rechazan
//      el HEAD/GET del SW sin el Referer de la página; con la regla DNR efímera
//      el fetch funciona y se obtiene el tamaño real. Es el mismo mecanismo de
//      la descarga (sw-fetch-blob), aplicado al enriquecimiento.
//   2. HEAD + Content-Length: último recurso (muchos CDNs no lo devuelven).
async function enrichSize(item, pageUrl = "") {
  if (sizeCache.has(item.url)) {
    item.sizeKB = sizeCache.get(item.url);
    return;
  }
  if (/^blob:|^data:/.test(item.url)) {
    item.sizeKB = 0;
    item.sizeUnknown = true;
    return;
  }
  try {
    let len = 0;

    // Nivel 0: tamaño ya registrado por el navegador (Performance API).
    if (item.sizeBytes && item.sizeBytes > 0) {
      len = item.sizeBytes;
    }

    // Nivel 1: GET real y contar los bytes del blob (independiente de cabeceras).
    if (len <= 0) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(item.url, { signal: ctrl.signal, cache: "force-cache" });
        clearTimeout(timer);
        if (res.ok) {
          const blob = await res.blob();
          len = blob.size;
        }
      } catch {
        len = 0; // CORS estricto / red: caer al siguiente nivel
      }
    }

    // Nivel 1.5: GET con Referer vía DNR (anti-hotlink, caso erome). Solo si el
    // recurso es de otro dominio que la página y las técnicas normales fallaron.
    if (len <= 0 && pageUrl && item.url.startsWith("http")) {
      try {
        let fromSame = false;
        try {
          fromSame = new URL(item.url).hostname === new URL(pageUrl).hostname;
        } catch { fromSame = false; }
        if (!fromSame) {
          const ruleId = await dnrSetRefererRule(item.url, pageUrl);
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            const res = await fetch(item.url, {
              referrer: pageUrl,
              referrerPolicy: "unsafe-url",
              cache: "no-store",
              signal: ctrl.signal,
            });
            clearTimeout(timer);
            if (res.ok) {
              const blob = await res.blob();
              len = blob.size;
            }
          } finally {
            if (ruleId) dnrClearRefererRule(item.url);
          }
        }
      } catch {
        len = 0;
      }
    }

    // Nivel 2: HEAD + Content-Length (menos fiable, último recurso).
    if (len <= 0) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(item.url, { method: "HEAD", signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        len = Number(res.headers.get("content-length") || 0);
      } catch {
        len = 0;
      }
    }

    const sizeKB = len > 0 ? Math.max(1, Math.round(len / 1024)) : 0;
    item.sizeKB = sizeKB;
    item.sizeUnknown = len <= 0;
    item.sizeBytes = len > 0 ? len : null;
    sizeCache.set(item.url, sizeKB);
  } catch {
    item.sizeKB = 0;
    item.sizeUnknown = true;
  }
}

// Enriquecer tamaños de los items que aún no tienen (fetch HEAD con caché).
// Concurrencia limitada (8) para no saturar; reenvía el estado al panel a
// medida que los tamaños se resuelven (el "?" se reemplaza en vivo).
async function enrichMissing(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const pendientes = tab.items.filter((i) => i.sizeKB === null && !i.sizeUnknown);
  if (!pendientes.length) return;
  console.log(`[operant-sw] enrichMissing tabId=${tabId}: ${pendientes.length} pendientes`);
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
  const worker = async () => {
    while (idx < pendientes.length) {
      const item = pendientes[idx++];
      await enrichSize(item, pageUrl); // usa sizeCache: no repite HEAD ya hecho
      processed++;
      persistTab(tabId);
      if (autoDetect) {
        chrome.runtime
          .sendMessage({ type: "state-updated", tabId, items: tab.items })
          .catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pendientes.length) }, worker));
  const stillNull = tab.items.filter((i) => i.sizeKB === null).length;
  console.log(`[operant-sw] enrichMissing fin tabId=${tabId}: procesados=${processed}, quedanNull=${stillNull}`);
}

// La cadena de detección/descarga (HEAD → Range → magic bytes → parseo de
// manifiesto) vive en src/shared/media-core.js (NTMedia) — ÚNICA fuente de
// verdad, compartida con el panel. Aquí solo se ejecuta la estrategia.

// --- Mensajería con el panel ---
let autoDetect = true;

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
    const tabId = msg.tabId ?? sender.tab?.id ?? 0;
    console.log("[operant-sw] media-updated tabId=", tabId, "items=", msg.items?.length, "senderTab=", sender.tab?.id);
    const tab = ensureTab(tabId);
    const byUrl = new Map(tab.items.map((it) => [it.url.split("#")[0], it]));
    for (const item of msg.items) byUrl.set(item.url.split("#")[0], item);
    tab.items = [...byUrl.values()].slice(0, MAX_ITEMS_PER_TAB);
    updateBadge(tabId);
    persistTab(tabId);
    enrichMissing(tabId); // tamaños de items del DOM (antes quedaban en "?")
    if (autoDetect) {
      chrome.runtime
        .sendMessage({ type: "state-updated", tabId, items: tab.items })
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "overlay-download") {
    // La decisión de estrategia la toma NTMedia.classifyDownload (media-core.js),
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
      // Preferir un manifiesto (m3u8/mpd): el flujo doManifest concatena
      // init+media y verifica looks_like_real_media en el host. Un .mp4
      // "directo" de X suele ser el init segment.
      const manifest = real.find((i) => isManifest(i.url));
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
    const base = msg.filename || urlBasename(url) || "descarga";
    const filename = /\.(png|jpe?g|webp|gif|mp4|mp3|pdf|zip|m3u8|mpd|ts)$/i.test(base) ? base : `${base}${urlExt(url)}`;
    const doDirect = () =>
      // Re-validar que la URL sigue viva (tokens que expiran) antes de descargar.
      NTMedia.isUrlAlive(url).then((alive) => {
        if (!alive) {
          return Promise.reject(new Error("La URL expiró o no está disponible. Re-escanea la página e inténtalo de nuevo."));
        }
        // Defensa ANTI-INIT: si el "directo" es un MP4 fragmentado (fMP4 de
        // X/Instagram), el init segment es solo moov/trak sin mdat/moof — un
        // archivo de cientos de bytes. Detectarlo por los bytes reales y
        // rechazar con un mensaje claro (el flujo caerá a manifiesto/yt-dlp).
        return detectInitOnlyMp4(url).then((isInit) => {
          if (isInit) {
            return Promise.reject(new Error("Se detectó un init segment (metadata sin vídeo). Reproduce el vídeo y vuelve a intentarlo; se usará el stream completo."));
          }
          return chrome.downloads.download({ url, filename: filename || undefined, conflictAction: "uniquify" });
        });
      });

    // ¿La URL es un MP4 que solo contiene metadata (init segment fMP4)?
    // CRITERIO SEGURO: solo se considera init si el archivo TOTAL es diminuto
    // (<50KB). Un vídeo real pesa MB — su primer fragmento puede tener moov
    // sin mdat todavía, y bloquearlo por los primeros KB daría falsos positivos
    // (el bug "ya no se descarga"). Un init segment de X pesa <1KB.
    async function detectInitOnlyMp4(u) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(u, { headers: { Range: "bytes=0-65535" }, signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        if (!res.ok && res.status !== 206 && res.status !== 200) return false;
        // Tamaño total conocido: si es >= 50KB, es un archivo real (no init).
        const total = Number(res.headers.get("content-range")?.split("/")[1] || res.headers.get("content-length") || 0);
        if (total >= 50 * 1024) return false;
        const buf = new Uint8Array(await res.arrayBuffer());
        const ascii = String.fromCharCode(...buf);
        if (!(ascii.includes("ftyp") || ascii.includes("moov"))) return false; // no es MP4
        // init segment: tiene moov pero no mdat ni moof (sin datos de media).
        return !ascii.includes("mdat") && !ascii.includes("moof");
      } catch {
        return false; // no se pudo verificar: no bloquear
      }
    }
    const doManifest = (manifest) => {
      // DASH con vídeo y audio SEPARADOS (Reddit/Instagram/…): el manifiesto
      // expone dos listas. Se toma el vídeo de mayor bitrate y el audio de
      // mayor bitrate y se remuxean con ffmpeg del host (dash-merge).
      if (manifest?.hasSeparateAudio && manifest.segments?.video?.length && manifest.segments?.audio?.length) {
        const bestVideo = manifest.segments.video.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
        const bestAudio = manifest.segments.audio.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
        const port = connectNative();
        if (!port) {
          sendResponse({ ok: false, error: "El host nativo no está instalado (necesario para unir vídeo+audio de DASH)." });
          return true;
        }
        try {
          // Si el parser DASH generó init + media segments (fMP4 de X), pasar
          // las listas completas al host para que las descargue y concatene.
          const vSegs = buildSegList(bestVideo);
          const aSegs = buildSegList(bestAudio);
          port.postMessage({
            type: "ffmpeg-op",
            url: bestVideo.url,
            op: "dash-merge",
            options: {
              videoUrl: bestVideo.url,
              audioUrl: bestAudio.url,
              filename: base,
              videoSegments: vSegs,
              audioSegments: aSegs,
            },
          });
          sendResponse({ ok: true, note: "Descargando vídeo y audio por separado y uniéndolos (DASH)…" });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return true;
      }
      const port = connectNative();
      // Fallback SIN host nativo: para m3u8, la ruta rápida completa en el SW
      // (antes solo se descargaba el propio archivo de playlist, inútil sin
      // el player). Para mpd/otros, el fetch directo de siempre.
      const manifestFallback = () =>
        /\.m3u8(?:[?#].*)?$/i.test(url)
          ? swFastHls(url, base, sender.tab?.id ?? null)
          : doFetchBlob();
      if (port) {
        try {
          port.postMessage({ type: "ffmpeg-op", url, op: "hls-dash", options: { filename: base } });
          sendResponse({ ok: true, note: "Convirtiendo stream a MP4 (máxima calidad)…" });
        } catch (e) {
          manifestFallback().then(() => sendResponse({ ok: true })).catch((e2) => sendResponse({ ok: false, error: String(e2) }));
        }
        return true;
      }
      manifestFallback().then((r) => sendResponse(r || { ok: true })).catch((e2) => sendResponse({ ok: false, error: String(e2) }));
      return true;
    };
    const doYtdl = () => {
      handleYtdl({ url, filename: base, format: null }).then((r) => sendResponse(r));
      return true;
    };

    NTMedia.classifyDownload(url, kind).then((c) => {
      if (c.strategy === "manifest") return doManifest(c.manifest);
      if (c.strategy === "ytdl") return doYtdl();
      if (c.strategy === "direct") {
        // Si el "directo" resultó ser un init segment (metadata vacía), no
        // entregar el archivo roto: caer a yt-dlp (X/Instagram se resuelven ahí).
        doDirect()
          .then(() => sendResponse({ ok: true }))
          .catch((e) => {
            if (/init segment/i.test(String(e?.message || e))) {
              doYtdl();
            } else {
              sendResponse({ ok: false, error: String(e?.message || e) });
            }
          });
        return true;
      }
      // unknown: intentar directo; si falla, yt-dlp.
      doDirect().then(() => sendResponse({ ok: true })).catch(() => doYtdl());
      return true;
    });
    return true;

    // Fetch+blob del manifiesto (fallback sin host nativo).
    async function doFetchBlob() {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { signal: ctrl.signal, cache: "force-cache" });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({ url: objUrl, filename: filename || undefined, conflictAction: "uniquify" });
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    }
  }
  if (msg?.type === "overlay-download-blob") {
    // Blob capturado DESDE EL CONTEXTO DE LA PÁGINA (con cookies/Referer de
    // sesión — para CDNs con anti-hotlink tipo erome). El SW de MV3 NO tiene
    // URL.createObjectURL, así que se reenvía al PANEL (que sí lo tiene y
    // además tiene chrome.downloads) para que lo entregue.
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
    const name = msg.filename || "descarga.mp4";
    const mime = msg.mime || "video/mp4";
    if (bytes.length > 128 * 1024 * 1024) {
      sendResponse({ ok: false, error: `El blob (${(bytes.length / 1048576).toFixed(0)} MB) supera el límite de entrega (128 MB). Descárgalo desde el panel (cola por chunks).` });
      return;
    }
    (async () => {
      try {
        const CHUNK = 0x8000; // 32KB por chunk de conversión
        let b64 = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        b64 = btoa(b64);
        const dataUrl = `data:${mime};base64,${b64}`;
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
    // regla DNR EFÍMERA por descarga (no hay lista de sitios). Resuelve CDNs
    // cross-origin que responden SIN Access-Control-Allow-Origin (tipo erome,
    // i.erome.com, cualquier host) donde el content script muere por CORS.
    const { url, filename } = msg;
    const pageUrl = msg.pageUrl || sender.tab?.url || "";
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    (async () => {
      const ruleId = await dnrSetRefererRule(url, pageUrl);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000);
        const res = await fetch(url, {
          referrer: pageUrl,
          referrerPolicy: "unsafe-url",
          cache: "no-store",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        // Defensa ANTI-INIT (CRITERIO SEGURO): solo se rechaza si el archivo
        // TOTAL es diminuto (<50KB) y es un MP4 sin datos (ftyp/moov sin
        // mdat/moof). Un vídeo real pesa MB — su primer fragmento puede tener
        // moov sin mdat todavía; bloquear por los primeros KB daría falsos
        // positivos (el bug "ya no se descarga"). Un init segment pesa <1KB.
        if (buf.byteLength < 50 * 1024) {
          const head = new Uint8Array(buf);
          const ascii = String.fromCharCode(...head);
          const isInitOnly = (ascii.includes("ftyp") || ascii.includes("moov")) && !ascii.includes("mdat") && !ascii.includes("moof");
          if (isInitOnly) {
            throw new Error("El recurso es metadata de stream (init segment), no un vídeo. Descarga el stream completo (manifiesto) o usa yt-dlp.");
          }
        }
        const name = filename || urlBasename(url) || "descarga.mp4";
        const mime = res.headers.get("content-type") || "application/octet-stream";
        // El SW de MV3 no tiene URL.createObjectURL. La única vía para entregar
        // el blob capturado es un data URL, PERO con límites reales:
        //  - `String.fromCharCode.apply` sobre el buffer completo revienta por
        //    stack overflow con >~50MB (verificado: RangeError con 100MB).
        //  - Los navegadores tienen un límite de tamaño de data URL (en la
        //    práctica ~64MB-1GB según máquina).
        // Por eso: base64 POR CHUNKS (32KB) para evitar el stack overflow, y un
        // TOPE de 128MB para el data URL (el tamaño de vídeo razonable; por
        // encima, el data URL puede fallar/congelar el navegador).
        // No hay transferencia binaria SW->panel: chrome.runtime.sendMessage no
        // serializa ArrayBuffer (llega {}), revienta con arrays planos grandes
        // y no serializa Uint8Array >64MB (todo verificado en pruebas).
        if (buf.byteLength > 128 * 1024 * 1024) {
          throw new Error(
            `El vídeo (${(buf.byteLength / 1048576).toFixed(0)} MB) supera el límite de entrega por data URL (128 MB). Descárgalo desde el panel (cola por chunks) o con yt-dlp.`
          );
        }
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000; // 32KB por chunk de conversión
        let b64 = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        b64 = btoa(b64);
        const dataUrl = `data:${mime};base64,${b64}`;
        await chrome.downloads.download({ url: dataUrl, filename: name, conflictAction: "uniquify" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      } finally {
        if (ruleId) dnrClearRefererRule(url); // regla efímera: limpiar al terminar
      }
    })();
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
    // Extraer SOLO el audio de un vídeo, con lógica inteligente:
    //  - URL directa (mp4/webm/mov): ffmpeg del host (extract-mp3, 192k).
    //  - URL no-directa (YouTube/Erome/streaming protegido): yt-dlp con -x
    //    (extracción de audio profesional por extractor).
    const url = msg.url || "";
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    const isDirectVideo = /\.(mp4|webm|mov|mkv|m4v|ogv|3gp)(?:[?#].*)?$/i.test(url);
    const port = connectNative();
    if (!port) {
      sendResponse({ ok: false, error: "El host nativo no está instalado (necesario para extraer audio)." });
      return;
    }
    if (isDirectVideo) {
      // Vídeo directo: ffmpeg extrae el audio a mp3.
      try {
        port.postMessage({ type: "ffmpeg-op", url, op: "extract-mp3", options: {} });
        sendResponse({ ok: true, note: "Extrayendo audio con ffmpeg del host…" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }
    // No-directo/plataforma: yt-dlp extrae el audio (bestaudio -> mp3).
    try {
      port.postMessage({ type: "ytdl", url, filename: msg.filename || "", format: "bestaudio/best" });
      sendResponse({ ok: true, note: "Extrayendo audio con yt-dlp…" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return;
  }
  if (msg?.type === "overlay-download-gif-video") {
    // GIF como vídeo (webm): lo convierte el host nativo con ffmpeg.
    const url = msg.url || "";
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
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
    // archivos grandes con hotlink por Referer (caso erome + 300MB).
    const { url, pageUrl } = msg;
    if (!url) {
      sendResponse({ ok: false, error: "Sin URL" });
      return;
    }
    dnrSetRefererRule(url, pageUrl || "").then((ruleId) => sendResponse({ ok: !!ruleId, ruleId }));
    return true; // respuesta asíncrona
  }
  if (msg?.type === "clear-dnr-referer") {
    if (msg.url) dnrClearRefererRule(msg.url);
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
});

async function handleYtdl(msg) {
  const port = connectNative();
  if (!port) {
    return { ok: false, error: "El host nativo no está instalado. Ejecuta native-host/install_host.bat <ID_EXTENSION>." };
  }
  try {
    port.postMessage({ type: "ytdl", url: msg.url, filename: msg.filename, format: msg.format || null });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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
    const name =
      (filename || urlBasename(url) || "video").replace(/\.(m3u8|mpd)$/i, "") + (result.kind === "ts" ? ".ts" : ".mp4");
    // base64 por chunks de 32KB: String.fromCharCode.apply con el buffer
    // completo revienta por stack overflow (verificado en el proyecto).
    const CHUNK = 0x8000;
    let b64 = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      b64 += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    const dataUrl = `data:${mime};base64,${btoa(b64)}`;
    await chrome.downloads.download({ url: dataUrl, filename: name, conflictAction: "uniquify" });
    return { ok: true, note: `Descargado por ruta rápida (${result.segments} segmentos).` };
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

async function handleGetState(tabId) {
  const tab = ensureTab(tabId);
  try {
    const stored = await chrome.storage.session.get(keyFor(tabId));
    if (stored[keyFor(tabId)] && tab.items.length === 0) {
      tab.items = stored[keyFor(tabId)];
    }
  } catch {
    /* sin persistencia */
  }
  // Pide un escaneo fresco al content script (si existe) y mezcla.
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "scan" });
    if (res?.items) {
      const byUrl = new Map(tab.items.map((it) => [it.url.split("#")[0], it]));
      for (const item of res.items) byUrl.set(item.url.split("#")[0], item);
      tab.items = [...byUrl.values()].slice(0, MAX_ITEMS_PER_TAB);
    }
    await enrichMissing(tabId); // esperar: los items vuelven con tamaño, no con "?"
    updateBadge(tabId);
    persistTab(tabId);
    return { items: tab.items, reachable: true };
  } catch {
    return { items: tab.items, reachable: false };
  }
}

async function requestScan(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    // force-rescan (no "scan"): re-ejecuta fullScan para que el progreso real
    // del barrido de estilos fluya al panel con el botón «Actualizar».
    const res = await chrome.tabs.sendMessage(tabId, { type: "force-rescan" });
    const tab = ensureTab(tabId);
    if (res?.items) {
      const byUrl = new Map(tab.items.map((it) => [it.url.split("#")[0], it]));
      for (const item of res.items) byUrl.set(item.url.split("#")[0], item);
      tab.items = [...byUrl.values()].slice(0, MAX_ITEMS_PER_TAB);
    }
    await enrichMissing(tabId); // esperar: los items vuelven con tamaño, no con "?"
    updateBadge(tabId);
    persistTab(tabId);
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
      if (msg?.type === "pong" || msg?.type === "tools-status") {
        nativeStatus = {
          installed: true,
          checkedAt: Date.now(),
          tools: msg.tools || null,
        };
        chrome.storage.local.set({ nativeStatus });
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
    return { ok: false, error: "El host nativo no está instalado. Ejecuta native-host/install_host.bat <ID_EXTENSION>." };
  }
  try {
    port.postMessage({ type: action, tool });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
