// media-core.js — ÚNICA FUENTE DE VERDAD para detección y descarga de medios.
// Compartido por el service worker (background.js) y el panel (panel.js).
// No usa chrome.* : es lógica pura + fetch, invocable desde ambos contextos.
// Expone un objeto global `NTMedia` para compatibilidad con script tags.

(function (global) {
  "use strict";

  // --- Clasificación por extensión de URL ---
  const EXT = {
    image: /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|heic|jxl)(?:[?#].*)?$/i,
    video: /\.(mp4|webm|mkv|avi|mov|m4v|ts|m3u8|mpd|ogv|3gp|flv|wmv)(?:[?#].*)?$/i,
    audio: /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|wma|aiff?)(?:[?#].*)?$/i,
    file: /\.(pdf|zip|rar|7z|tar|gz|bz2|xz|docx?|xlsx?|pptx?|epub|apk|exe|msi|dmg|iso|txt|md|json|csv)(?:[?#].*)?$/i,
  };

  function classifyExt(url) {
    for (const [kind, re] of Object.entries(EXT)) {
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

  // Extensiones "directas" (archivo real descargable tal cual).
  const DIRECT_VIDEO = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "3gp"]);
  const DIRECT_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tiff", "tif", "heic", "jxl"]);
  const DIRECT_AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus", "wma", "aiff"]);
  const DIRECT_FILE = new Set(["pdf", "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub", "apk", "exe", "msi", "dmg", "iso", "txt", "md", "json", "csv"]);

  // --- Sniffing de contenido real ---

  // Nivel 1: HEAD -> Content-Type del servidor.
  async function fetchHead(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, contentType: res.headers.get("content-type") || "" };
    } catch {
      clearTimeout(timer);
      return { ok: false, status: 0, contentType: "" };
    }
  }

  // Nivel 2: GET con Range (0-511) — fallback cuando HEAD falla o es ambiguo.
  async function fetchRangeHead(url, bytes = 511) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=0-${bytes}` }, signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok && res.status !== 206 && res.status !== 200) return { ok: false, status: res.status };
      const buf = new Uint8Array(await res.arrayBuffer());
      return { ok: true, status: res.status, bytes: buf, contentType: res.headers.get("content-type") || "" };
    } catch {
      clearTimeout(timer);
      return { ok: false, status: 0 };
    }
  }

  // Nivel 3: detectar formato por magic bytes del contenido real.
  function detectMagic(buf) {
    if (!buf || buf.length < 4) return "";
    const hex = buf.slice(0, 16).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "").toUpperCase();
    const ascii = String.fromCharCode(...buf.slice(0, 64));
    if (ascii.slice(4, 8) === "ftyp" || ascii.slice(0, 4) === "ftyp") return "mp4";
    if (hex.startsWith("1A45DFA3")) return "webm";
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "gif";
    if (hex.startsWith("89504E47")) return "png";
    if (hex.startsWith("FFD8FF")) return "jpeg";
    if (ascii.trimStart().startsWith("#EXTM3U")) return "hls";
    if (ascii.includes("<MPD") || (ascii.trimStart().startsWith("<?xml") && ascii.includes("MPD"))) return "dash";
    if (ascii.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
    if (ascii.slice(0, 4) === "RIFF" && ascii.slice(8, 12) === "WEBP") return "webp";
    return "";
  }

  // Nivel 4: parsear manifiesto HLS/DASH (sin yt-dlp) -> {type, segments[]}.
  // Extrae los atributos de un <SegmentTemplate ...> para construir URLs de
  // init + media segments con $Number$/$Time$/$RepresentationID$.
  function parseSegmentTemplate(attrs) {
    const a = (attrs || "").replace(/\/\s*$/, "").trim(); // quitar self-closing
    const g = (name) => (a.match(new RegExp(`${name}=["']([^"']+)["']`, "i")) || [])[1] || "";
    const media = g("media");
    if (!media) return null; // null (no {}): permite el fallback al template del set
    const tpl = {
      media,
      initialization: g("initialization"),
      startNumber: g("startNumber") !== "" ? Number(g("startNumber")) : undefined,
    };
    const dur = g("duration");
    const timescale = g("timescale") !== "" ? Number(g("timescale")) : 1;
    if (dur && timescale) {
      // Sin SegmentTimeline, el número de segmentos es la duración total / dur.
      tpl.duration = Number(dur);
      tpl.timescale = timescale;
      tpl.segmentCount = undefined;
    }
    return tpl;
  }

  async function parseManifest(url, contentType, firstBytes) {
    try {
      let hint = "";
      if (contentType) hint = contentType.toLowerCase();
      if (firstBytes && firstBytes.length) {
        const sample = String.fromCharCode(...firstBytes.slice(0, 200));
        if (sample.includes("#EXTM3U")) hint += " mpegurl";
        if (sample.includes("<MPD")) hint += " dash+xml";
      }
      const isHls = /mpegurl|#EXTM3U/i.test(hint) || /\.m3u8(?:[?#].*)?$/i.test(url);
      const isDash = /dash\+xml/i.test(hint) || /\.mpd(?:[?#].*)?$/i.test(url);
      if (!isHls && !isDash) return null;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) return null;
      const full = await res.text();

      if (isDash) {
        const base = url.slice(0, url.lastIndexOf("/") + 1);
        // Duración total del MPD (PT8.0S) para derivar el nº de segmentos.
        let totalSec = 0;
        const durAttr = (full.match(/mediaPresentationDuration="([^"]+)"/i) || [])[1] || "";
        const dm = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(durAttr);
        if (dm) totalSec = (Number(dm[1] || 0) * 3600) + (Number(dm[2] || 0) * 60) + Number(dm[3] || 0);
        // DASH: cada AdaptationSet tiene un contentType/mimeType (video/audio).
        // Se recorren los AdaptationSets y las Representations de cada uno.
        // Soporta SegmentTemplate con $Number$/$Time$ (fMP4, el formato de X)
        // y SegmentList explícito. Sin esto, un init segment (metadata vacía)
        // se confundiría con el archivo completo (bug del archivo de 705 B).
        const videoQualities = [];
        const audioQualities = [];
        const setRe = /<AdaptationSet\b[^>]*>([\s\S]*?)<\/AdaptationSet>/gi;
        let setMatch;
        while ((setMatch = setRe.exec(full))) {
          const setBody = setMatch[1];
          const setAttrs = setMatch[0].slice(0, setMatch[0].length - setBody.length - "</AdaptationSet>".length);
          const mime = (setAttrs.match(/mimeType="([^"]+)"/i) || [])[1] || "";
          const ct = (setAttrs.match(/contentType="([^"]+)"/i) || [])[1] || "";
          const kind = ct || mime.split("/")[0]; // "video" | "audio"

          // SegmentTemplate del AdaptationSet (puede estar en el tag de apertura
          // o como hijo del set — X lo pone como hijo). Se busca en ambos.
          const setTpl = (setAttrs.match(/<SegmentTemplate\b([^>]*)>/i) || [])[1] || "";
          const setBodyTpl = (setBody.match(/<SegmentTemplate\b([^>]*)\/?>/i) || [])[1] || "";
          const tplInSet = parseSegmentTemplate(setTpl || setBodyTpl);

          const reps = setBody.matchAll(/<Representation\b[^>]*bandwidth="?(\d+)"?[^>]*>([\s\S]*?)<\/Representation>/gi);
          for (const m of reps) {
            const repBody = m[2];
            const b = repBody.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
            const repTplAttr = (m[0].match(/<SegmentTemplate\b([^>]*)>/) || [])[1] || "";
            const repTpl = parseSegmentTemplate(repTplAttr);
            const tpl = repTpl || tplInSet;
            // URLs explícitas (SegmentList/SegmentURL dentro de la Representation).
            const segUrls = [];
            const segRe = /<SegmentURL\b[^>]*media="([^"]+)"/gi;
            let sm;
            while ((sm = segRe.exec(repBody))) segUrls.push(new URL(sm[1].trim(), base).href);
            // SegmentTemplate: init + media con $Number$/$Time$.
            let initUrl = "";
            let segments = [];
            if (tpl.media) {
              initUrl = tpl.initialization ? new URL(tpl.initialization.replace("$RepresentationID$", m[1]), base).href : "";
              const start = tpl.startNumber !== undefined ? tpl.startNumber : 0;
              // Nº de segmentos: de la duración total del MPD / duración del
              // segmento (timescale+duration del template), si se conocen.
              let n = tpl.segmentCount || 1;
              if (tpl.duration && tpl.timescale && totalSec > 0) {
                n = Math.max(1, Math.ceil(totalSec / (tpl.duration / tpl.timescale)));
              }
              for (let k = 0; k < n; k++) {
                const num = start + k;
                segments.push(new URL(tpl.media.replace(/\$RepresentationID\$/g, m[1]).replace(/\$Number\$/g, num).replace(/\$Number%0(\d+)d\$/g, (_, w) => String(num).padStart(Number(w), "0")), base).href);
              }
            } else if (segUrls.length) {
              segments = segUrls;
            }
            // Sin BaseURL ni segmentos (Representation vacía): descartar.
            if (!b && !segments.length && !initUrl) continue;
            const q = {
              id: m[1],
              label: `${(Number(m[1]) / 1e6).toFixed(1)} Mbps`,
              url: b ? new URL(b[1].trim(), base).href : "",
              kind,
              initUrl,
              segments,
            };
            if (kind === "audio") audioQualities.push(q);
            else videoQualities.push(q);
          }
        }
        // Si no se encontró ningún AdaptationSet (XML con otra forma), fallback:
        // todas las Representations como vídeo (comportamiento previo).
        if (!videoQualities.length && !audioQualities.length) {
          const reps = full.matchAll(/<Representation[^>]*bandwidth="?(\d+)"?[^>]*>([\s\S]*?)<\/Representation>/gi);
          for (const m of reps) {
            const b = m[2].match(/<BaseURL>([^<]+)<\/BaseURL>/i);
            if (!b) continue;
            videoQualities.push({ id: m[1], label: `${(Number(m[1]) / 1e6).toFixed(1)} Mbps`, url: new URL(b[1].trim(), base).href, kind: "video", initUrl: "", segments: [] });
          }
        }
        if (!videoQualities.length && !audioQualities.length) return null;
        return {
          type: "dash",
          // Un solo stream (solo vídeo) -> lista plana (compatibilidad previa).
          // Vídeo + audio separados -> { video: [...], audio: [...] } (Parte B).
          segments: audioQualities.length ? { video: videoQualities, audio: audioQualities } : videoQualities,
          hasSeparateAudio: audioQualities.length > 0,
        };
      }

      const base = url.slice(0, url.lastIndexOf("/") + 1);
      if (full.includes("#EXT-X-STREAM-INF")) {
        // Manifiesto maestro: variantes.
        const qualities = [];
        const blocks = full.match(/#EXT-X-STREAM-INF:[^\n]*\n([^\n]+)/g) || [];
        for (const block of blocks) {
          const lines = block.split("\n");
          const bw = lines[0].match(/BANDWIDTH=(\d+)/)?.[1];
          const uri = lines[1]?.trim();
          if (!uri || uri.startsWith("#")) continue;
          qualities.push({ id: bw || String(qualities.length), label: bw ? `${(Number(bw) / 1e6).toFixed(1)} Mbps` : "media", url: new URL(uri, base).href });
        }
        return qualities.length ? { type: "hls-master", segments: qualities } : null;
      }
      // Manifiesto media: segmentos.
      const segs = (full.match(/^[^#\n][^\n]*$/gm) || [])
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"))
        .map((s) => new URL(s, base).href);
      return segs.length ? { type: "hls", segments: segs } : null;
    } catch {
      return null;
    }
  }

  // Nivel 6: re-validar que la URL sigue viva (tokens que expiran).
  async function isUrlAlive(url) {
    const h = await fetchHead(url);
    if (h.ok) return true;
    if (h.status === 403 || h.status === 405) {
      const r = await fetchRangeHead(url, 0);
      return r.ok;
    }
    return false;
  }

  // ====================================================================
  // `classifyDownload(url)` — CADENA ÚNICA de decisión de descarga.
  // Devuelve { strategy, ext, contentType, magic, manifest } donde:
  //   strategy: "direct" | "manifest" | "ytdl" | "unknown"
  // El llamador decide cómo ejecutar (chrome.downloads / ffmpeg / yt-dlp).
  // ====================================================================
  async function classifyDownload(url, kind = "") {
    const ext = extOf(url).toLowerCase();

    // N1: extensión clara -> directo.
    if (DIRECT_VIDEO.has(ext) || DIRECT_IMAGE.has(ext) || DIRECT_AUDIO.has(ext) || DIRECT_FILE.has(ext)) {
      return { strategy: "direct", ext, reason: `extensión .${ext}` };
    }
    // N1b: manifiesto por extensión -> intentar parseo propio (calidades).
    if (ext === "m3u8" || ext === "mpd") {
      const manifest = await parseManifest(url, "");
      if (manifest) return { strategy: "manifest", ext, manifest, reason: `extensión .${ext}` };
      return { strategy: "manifest", ext, reason: `extensión .${ext}` };
    }

    // N2: HEAD -> Content-Type real.
    const head = await fetchHead(url);
    const ct = (head.contentType || "").toLowerCase();

    // Content-Type de medios claro.
    if (/video\/|audio\/|application\/mp4/.test(ct)) {
      // ¿Parece manifiesto por Content-Type?
      if (/mpegurl|dash\+xml/.test(ct)) {
        const manifest = await parseManifest(url, ct);
        if (manifest) return { strategy: "manifest", ext, contentType: ct, manifest, reason: `Content-Type ${ct} (manifiesto)` };
      }
      return { strategy: "direct", ext, contentType: ct, reason: `Content-Type ${ct}` };
    }
    if (/application\/x-mpegurl|application\/dash\+xml/.test(ct)) {
      const manifest = await parseManifest(url, ct);
      if (manifest) return { strategy: "manifest", ext, contentType: ct, manifest, reason: `Content-Type ${ct}` };
      return { strategy: "direct", ext, contentType: ct, reason: `Content-Type ${ct}` };
    }

    // N3: HEAD ambiguo/fallido -> GET+Range + magic bytes.
    let magic = "";
    let sample = null;
    if (!head.ok || /text\/html|application\/octet-stream|^$/.test(ct)) {
      const ranged = await fetchRangeHead(url, 511);
      if (ranged.ok && ranged.bytes) {
        sample = ranged.bytes;
        magic = detectMagic(ranged.bytes);
      }
    }

    if (magic === "hls" || magic === "dash") {
      const manifest = await parseManifest(url, ct, sample);
      if (manifest) return { strategy: "manifest", ext, magic, manifest, reason: `magic bytes ${magic}` };
    }
    if (["mp4", "webm", "mov", "gif", "png", "jpeg", "webp", "mp3"].includes(magic)) {
      return { strategy: "direct", ext, magic, reason: `magic bytes ${magic}` };
    }

    // N5: HTML real, plataforma conocida o desconocido -> yt-dlp como último recurso.
    if (kind === "video" && (magic === "" || /text\/html/.test(ct))) {
      return { strategy: "ytdl", ext, contentType: ct, magic, reason: "URL no-descargable o plataforma" };
    }
    return { strategy: "unknown", ext, contentType: ct, magic, reason: "sin firma conocida" };
  }

  // API pública.
  const NTMedia = {
    classifyExt,
    extOf,
    fetchHead,
    fetchRangeHead,
    detectMagic,
    parseManifest,
    isUrlAlive,
    classifyDownload,
    EXT,
    DIRECT_VIDEO,
    DIRECT_IMAGE,
    DIRECT_AUDIO,
    DIRECT_FILE,
  };

  global.NTMedia = NTMedia;
  // Soporte dual: script tag clásico (global) o ES module (export).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = NTMedia;
  }
  if (typeof exports !== "undefined" && typeof exports !== "function") {
    exports.NTMedia = NTMedia;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

// Export explícito para import ES module (service worker).
export const NTMedia = globalThis.NTMedia;
export default globalThis.NTMedia;
