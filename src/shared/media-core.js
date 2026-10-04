// media-core.js — ÚNICA FUENTE DE VERDAD para detección y descarga de medios.
// Compartido por el service worker (background.js) y el panel (panel.js).
// No usa chrome.* : es lógica pura + fetch, invocable desde ambos contextos.
// Expone un objeto global `OperantMedia` para compatibilidad con script tags.

(function (global) {
  "use strict";

  // --- Clasificación por extensión de URL ---
  //
  // `classifyExt` se aplica SOBRE EL PATHNAME, nunca sobre la URL completa.
  // Antes el regex se probaba contra la URL entera, con lo que cualquier query
  // string acababa decidiendo el tipo:
  //   https://cdn/seg1.ts?ref=https://otro/logo.png   -> "image" (¡es vídeo!)
  //   https://site/watch?v=1&poster=https://…/p.jpg   -> "image" (¡es vídeo!)
  // Es un fallo de clasificacion dirigido por la pagina, y produce items mal
  // tipados en el panel.
  //
  // La query SÍ se consulta, pero solo con parámetros que los CDNs usan para
  // declarar el formato, y NUNCA para heredar una extensión de un parámetro
  // arbitrario (`?file=logo.png` no convierte un vídeo en imagen).
  const EXT_PATH = {
    image: /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif|jxl)$/i,
    video: /\.(mp4|webm|mkv|avi|mov|m4v|m3u8|mpd|ogv|3gp|flv|wmv)$/i,
    audio: /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|wma|aiff?)$/i,
    file: /\.(pdf|zip|rar|7z|tar|gz|bz2|xz|docx?|xlsx?|pptx?|epub|apk|exe|msi|dmg|iso|txt|md|json|csv)$/i,
  };

  // `.ts` es ambiguo por naturaleza: MPEG-TS (segmento de HLS, muy habitual) y
  // TypeScript (código fuente). No se puede decidir por la extensión, así que
  // se clasifica como vídeo SOLO si el pathname es exactamente un `.ts` Y la
  // URL no parece una entrega de código fuente. Es la única señal disponible
  // antes de mirar la red; el sniff de Content-Type la confirma después.
  const TS_SOURCE_HINT = /(?:^|[?&])(?:type|kind)=?(?:typescript|source|script)\b/i;

  // Parámetros de query que SÍ declaran formato en CDNs reales.
  const FORMAT_PARAMS = ["format", "fm", "output", "f", "ext", "type"];

  function classifyExt(url) {
    let pathname = "";
    let search = "";
    try {
      const u = new URL(url);
      pathname = decodeURIComponentSafe(u.pathname);
      search = u.search;
    } catch {
      pathname = String(url || "").split(/[?#]/)[0];
    }

    for (const [kind, re] of Object.entries(EXT_PATH)) {
      if (re.test(pathname)) return kind;
    }

    // `.ts` con criterio explícito.
    if (/\.ts$/i.test(pathname) && !TS_SOURCE_HINT.test(search)) {
      // Un `.ts` en un path de código fuente (src/, lib/, types/) es TypeScript.
      if (/(?:^|\/)(?:src|lib|types|typings|node_modules|dist|build)\//i.test(pathname)) return "file";
      return "video";
    }
    // El propio parámetro declara que es código fuente: es un fichero, no un
    // medio, y no hay nada más que deducir del path.
    if (/\.ts$/i.test(pathname) && TS_SOURCE_HINT.test(search)) return "file";

    // Solo parámetros de formato conocidos, y solo si el valor es una extensión
    // real de una de nuestros grupos.
    if (search) {
      for (const key of FORMAT_PARAMS) {
        const m = new RegExp(`[?&]${key}=([^&#]+)`, "i").exec(search);
        if (!m) continue;
        const value = decodeURIComponentSafe(m[1]).replace(/^\./, "").toLowerCase();
        for (const [kind, re] of Object.entries(EXT_PATH)) {
          if (re.test(`.${value}`)) return kind;
        }
      }
    }

    return null;
  }

  // decodeURIComponent lanza URIError con percent-encoding malformado, y eso no
  // puede hacer que la clasificación de una URL reviente.
  function decodeURIComponentSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
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
  //
  // `m4s` NO está en ninguna: es un segmento fMP4/CMAF, un TROZO de medio, no un
  // archivo. Ofrecerlo como descarga directa produce un fichero que no se
  // reproduce. Tampoco `ts`: necesita sniff de Content-Type (ver classifyExt).
  const DIRECT_VIDEO = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "3gp"]);
  const DIRECT_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tiff", "tif", "heic", "heif", "jxl"]);
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

  // Marcas 'ftyp' de ISO-BMFF. El campo `ftyp` NO dice el tipo: dice la MARCA.
  // Tratar cualquier `ftyp` como mp4 clasificaba como vídeo un AVIF, un HEIC,
  // un M4A y hasta un segmento CMAF (.m4s) — con la consecuencia de que la UI
  // ofrecía "descargar vídeo" para una imagen y la descarga movía el fichero con
  // la extensión equivocada.
  //
  // Fuentes: ISO/IEC 14496-12 (ftyp), ISO/IEC 23000-20 (AVIF/HEIF),
  // ISO/IEC 23003-5 (CMAF).
  const IMAGE_BRANDS = new Set([
    "avif", "avis", // AVIF (still / sequence)
    "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", // HEIF
    "mif1", "msf1", // HEIF genérico
    "crx ", // Canon RAW (contenedor basado en BMFF)
  ]);
  // HEIC se devuelve como "heic" y no como "avif": ambos son imagen, pero la
  // extensión correcta importa al nombrar el fichero descargado, y un HEIC
  // renombrado a .avif no lo abren los visores que sí lo soportan.
  const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
  const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);
  // CMAF: fragmentos de audio (cmfa) y de vídeo (cmfv/cmfc). NO son archivos
  // descargables por sí solos: son trozos que hay que concatenar.
  const FRAGMENT_BRANDS = new Set(["cmfc", "cmfs", "cmff", "cmft", "cmfv", "cmfa", "cmaf"]);

  // Extrae las marcas de un FileBox: la major brand y las compatible brands.
  function readFtypBrands(buf) {
    const size =
      buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
        ? null // tamaño 64 bits: no se usa, pero no debe romper
        : (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
    const limit = size && size > 8 && size <= buf.length ? Math.min(size, buf.length) : Math.min(buf.length, 64);
    const brands = [];
    // minor_version ocupa los bytes 8..11; la major brand, 12..15.
    if (limit >= 16) brands.push(String.fromCharCode(buf[12], buf[13], buf[14], buf[15]));
    for (let i = 16; i + 3 < limit; i += 4) {
      brands.push(String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]));
    }
    return brands;
  }

  // Nivel 3: detectar formato por magic bytes del contenido real.
  function detectMagic(buf) {
    if (!buf || buf.length < 4) return "";
    const hex = buf.slice(0, 16).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "").toUpperCase();
    const ascii = String.fromCharCode(...buf.slice(0, 64));

    // --- ISO-BMFF: decidir por MARCA, no por la presencia de 'ftyp' ---
    if (ascii.slice(4, 8) === "ftyp") {
      const brands = readFtypBrands(buf);
      if (brands.some((b) => HEIF_BRANDS.has(b))) return "heic";
      if (brands.some((b) => IMAGE_BRANDS.has(b))) return "avif";
      if (brands.some((b) => AUDIO_BRANDS.has(b))) return "m4a";
      if (brands.some((b) => FRAGMENT_BRANDS.has(b))) return "m4s";
      // Cualquier otra marca ISO-BMFF (isom, mp42, avc1, dash, qt, ...) es un
      // MP4 contenedor. Es el valor por defecto correcto para la enorme mayoría
      // de las marcas reales, así que no hace falta enumerarlas: los casos que
      // NO son MP4 se han resuelto ya por marca.
      return "mp4";
    }

    if (hex.startsWith("1A45DFA3")) return "webm"; // Matroska / WebM
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "gif";
    if (hex.startsWith("89504E47")) return "png";
    if (hex.startsWith("FFD8FF")) return "jpeg";
    if (hex.startsWith("424D")) return "bmp"; // "BM"
    if (hex.startsWith("49492A00") || hex.startsWith("4D4D002A")) return "tiff";
    if (hex.startsWith("00000100")) return "ico";
    if (ascii.startsWith("fLaC")) return "flac";
    if (ascii.startsWith("OggS")) return "ogg";
    if (ascii.trimStart().startsWith("#EXTM3U")) return "hls";
    if (ascii.includes("<MPD") || (ascii.trimStart().startsWith("<?xml") && ascii.includes("MPD"))) return "dash";
    if (ascii.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
    if (ascii.slice(0, 4) === "RIFF") {
      const form = ascii.slice(8, 12);
      if (form === "WEBP") return "webp";
      if (form === "WAVE") return "wav";
      if (form === "AVI ") return "avi";
    }
    return "";
  }

  // Nivel 4: parsear manifiesto HLS/DASH (sin yt-dlp) -> {type, segments[]}.
  function resolveRel(uri, base) {
    try {
      return new URL(uri, base).href;
    } catch {
      return uri;
    }
  }

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
    // `timescale` es INDEPENDIENTE de `duration`: un SegmentTimeline no lleva
    // `duration` (la duración la da cada <S d>) y sí necesita `timescale` para
    // interpretar `t`. Leyéndolo solo dentro del `if (dur && timescale)` se
    // quedaba en 1 y las timeline se contaban mal (un `r="-1"` de 2 s sobre un
    // timescale de 1000 se leía como 2000 s por segmento).
    const timescale = g("timescale") !== "" ? Number(g("timescale")) : 1;
    tpl.timescale = timescale > 0 ? timescale : 1;
    if (dur) {
      // Sin SegmentTimeline, el número de segmentos es la duración total / dur.
      tpl.duration = Number(dur);
      tpl.segmentCount = undefined;
    }
    return tpl;
  }

  // SegmentTimeline (ISO/IEC 23009-1 §5.3.9.2): en vez de "N segmentos de
  // duración fija", el manifest DECLARA la línea de tiempo segmento a segmento.
  // Es la forma que usan los streams con duración variable (keyframes
  // irregulares) y sin ella el número de segmentos se deducía de
  // duración_total / duración_segmento, que con `d` variable salía mal y con
  // `r` ni se intentaba.
  //
  // Cada <S> aporta:
  //   t = tiempo de inicio en unidades de `timescale` (opcional: si falta, el
  //       segmento empieza donde acabó el anterior),
  //   d = duración (obligatoria),
  //   r = repeticiones ADICIONALES (`r` repeticiones = r+1 segmentos).
  //       `r="-1"` = repetir hasta el fin del Period (o hasta el `t` del
  //       siguiente <S>, si lo hay).
  //
  // Devuelve [{ t, d }] en unidades de timescale, o null si no hay timeline.
  function parseSegmentTimeline(xml, timescale, periodSec) {
    const block = (xml || "").match(/<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i);
    if (!block) return null;
    const ts = Number(timescale) > 0 ? Number(timescale) : 1;
    const periodEnd = Number(periodSec) > 0 ? Math.round(Number(periodSec) * ts) : Infinity;
    const entries = [];
    for (const m of block[1].matchAll(/<S\b([^>]*)\/?>/gi)) {
      const attrs = m[1];
      const num = (name) => {
        const v = (attrs.match(new RegExp(`${name}=["']([^"']*)["']`, "i")) || [])[1];
        return v === undefined || v === "" ? undefined : Number(v);
      };
      const d = num("d");
      if (!Number.isFinite(d) || d <= 0) continue; // `d` es obligatoria
      const t = num("t");
      const r = num("r");
      entries.push({ t, d, r: r === undefined ? 0 : r });
    }
    if (!entries.length) return null;

    const out = [];
    let current = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.t !== undefined && Number.isFinite(e.t)) current = e.t;
      // Techo de la repetición negativa: el `t` del siguiente <S>, si existe.
      const nextT = i + 1 < entries.length ? entries[i + 1].t : undefined;
      const limit = e.r < 0 ? Math.min(periodEnd, Number.isFinite(nextT) ? nextT : Infinity) : Infinity;
      if (e.r < 0) {
        // Guarda contra timelines degenerados (d=1 con periodEnd enorme):
        // sin tope se generan millones de segmentos y la descarga se cuelga.
        let guard = 0;
        while (current < limit && guard++ < 100000) {
          out.push({ t: current, d: e.d });
          current += e.d;
        }
      } else {
        const repeats = Math.max(0, Math.floor(e.r));
        for (let k = 0; k <= repeats; k++) {
          out.push({ t: current, d: e.d });
          current += e.d;
        }
      }
    }
    return out.length ? out : null;
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

      // Base para resolver URLs relativas del manifest.
      //
      // Antes: `url.slice(0, url.lastIndexOf("/") + 1)`. Eso parte la URL
      // INCLUDINGO la query string, de modo que un manifest en
      // `https://cdn/x.m3u8?p=a/b` producía la base `https://cdn/x.m3u8?p=a/`
      // y TODOS los segmentos colgantes fallaban con 404.
      //
      // Lo correcto según RFC 3986 es resolver cada URL relativa contra la URL
      // COMPLETA del manifest: el parser de URL se encarga de descartar la
      // query al resolver una ruta relativa.
      const base = url;

      if (isDash) {
        // Duración total del MPD (PT8.0S, PT0DT0H0M8S, PT1H2M3.5S) para derivar
        // el nº de segmentos.
        //
        // El regex anterior (/PT(?:H)?(?:M)?(?:S)?/) NO aceptaba el campo de
        // días, que los muxers reales sí emiten ("PT0DT0H0M8S"). Con un MPD de
        // 8 s y segmentos de 4 s eso devolvía totalSec = 0, la cuenta de
        // segmentos caía a 1, y la descarga se quedaba con el primer segmento:
        // un MP4 truncado que parecía correcto.
        let totalSec = 0;
        const durAttr = (full.match(/mediaPresentationDuration="([^"]+)"/i) || [])[1] || "";
        const dm = /^(?:P(?:(\d+(?:\.\d+)?)D)?)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(durAttr.trim());
        if (dm && dm[0] !== "P" && dm[0] !== "PT") {
          const d = Number(dm[1] || 0);
          const h = Number(dm[2] || 0);
          const mnt = Number(dm[3] || 0);
          const s = Number(dm[4] || 0);
          totalSec = d * 86400 + h * 3600 + mnt * 60 + s;
        }
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
          //
          // IMPORTANTE: al buscar el template DEL SET hay que ignorar los que
          // están dentro de una Representation. Antes se buscaba en el cuerpo
          // entero del set, así que el template de la primera Representation
          // se heredaba a TODAS las demás: una Representation sin template
          // propio acababa con los segmentos de otra, y si la primera no lo
          // tenía, ninguna lo tenía.
          const setTpl = (setAttrs.match(/<SegmentTemplate\b([^>]*)/i) || [])[1] || "";
          const setBodyOutsideReps = setBody.replace(
            /<Representation\b[\s\S]*?<\/Representation>/gi,
            ""
          );
          const setBodyTpl =
            (setBodyOutsideReps.match(/<SegmentTemplate\b([^>]*)/i) || [])[1] || "";
          const tplInSet = parseSegmentTemplate(setTpl || setBodyTpl);

          // Se captures el `id` de la Representation: es lo que expande
          // $RepresentationID$ en los SegmentTemplate. Antes se usaba el
          // `bandwidth` (m[1]), con lo que cualquier manifest que usara
          // $RepresentationID$ generaba URLs de segmentos equivocadas.
          const reps = setBody.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi);
          for (const m of reps) {
            const repAttrs = m[1] || "";
            const repBody = m[2];
            const repId = (repAttrs.match(/\bid="([^"]*)"/i) || [])[1] || "";
            const bandwidth = (repAttrs.match(/\bbandwidth="?(\d+)"?/i) || [])[1] || "";
            // $RepresentationID$ se expande con el id; si el Representation no
            // tiene id, es un manifest mal formado y no se puede construir la
            // URL: no se inventa nada.
            const repIdToken = repId || "";
            const b = repBody.match(/<BaseURL>([^<]+)<\/BaseURL>/i);

            // El SegmentTemplate puede estar en el tag de apertura de la
            // Representation o como hijo suyo. ANTES solo se buscaba en `m[0]`,
            // que es el tag de APERTURA: un <SegmentTemplate> hijo nunca podía
            // aparecer ahí, así que los templates a nivel Representation eran
            // INALCANZABLES y se caía al del AdaptationSet.
            const repTplOpen = (repAttrs.match(/<SegmentTemplate\b([^>]*)/i) || [])[1] || "";
            const repTplBody = (repBody.match(/<SegmentTemplate\b([^>]*)/i) || [])[1] || "";
            const repTpl = parseSegmentTemplate(repTplOpen || repTplBody);

            // Guard: si no hay ningún template, `tpl` es null y el acceso a
            // `tpl.media` lanzaba TypeError, que abortaba el manifest DASH
            // COMPLETO (no solo esta Representation).
            const tpl = repTpl || tplInSet;
            if (!tpl) {
              // Sin template y sin SegmentURL esta Representation no aporta
              // nada descargable; se descarta en lugar de romper el parseo.
              if (!/<SegmentURL\b/i.test(repBody)) continue;
            }
            // Cuerpo del elemento que contiene el template: es donde vive el
            // <SegmentTimeline>. El template puede estar en el tag de apertura
            // del AdaptationSet/Representation o en su cuerpo, pero en ambos
            // casos la timeline es hija del MISMO elemento.
            const tplBody = repTpl ? repBody : setBodyOutsideReps;

            // URLs explícitas (SegmentList/SegmentURL dentro de la Representation).
            const segUrls = [];
            const segRe = /<SegmentURL\b[^>]*media="([^"]+)"/gi;
            let sm;
            while ((sm = segRe.exec(repBody))) segUrls.push(new URL(sm[1].trim(), base).href);

            // SegmentTemplate: init + media con $Number$/$Time$.
            let initUrl = "";
            let segments = [];
            if (tpl && tpl.media) {
              const expand = (s) =>
                s
                  .replace(/\$RepresentationID\$/g, repIdToken)
                  .replace(/\$RepresentationID%/g, repIdToken);
              initUrl = tpl.initialization ? new URL(expand(tpl.initialization), base).href : "";
              const start = tpl.startNumber !== undefined ? tpl.startNumber : 0;
              const expandNum = (num) =>
                expand(tpl.media)
                  .replace(/\$Number\$/g, String(num))
                  .replace(/\$Number%0(\d+)d\$/g, (_, w) => String(num).padStart(Number(w), "0"));
              // SegmentTimeline manda sobre el cálculo por duración fija: si el
              // manifest declara la línea de tiempo, es la fuente de verdad.
              const timeline = parseSegmentTimeline(tplBody || "", tpl.timescale, totalSec);
              if (timeline) {
                for (let k = 0; k < timeline.length; k++) {
                  const url = expandNum(start + k).replace(/\$Time\$/g, String(timeline[k].t));
                  segments.push(new URL(url, base).href);
                }
              } else {
                // Nº de segmentos: de la duración total del MPD / duración del
                // segmento (timescale+duration del template), si se conocen.
                let n = tpl.segmentCount || 1;
                if (tpl.duration && tpl.timescale && totalSec > 0) {
                  n = Math.max(1, Math.ceil(totalSec / (tpl.duration / tpl.timescale)));
                }
                for (let k = 0; k < n; k++) {
                  segments.push(new URL(expandNum(start + k), base).href);
                }
              }
            } else if (segUrls.length) {
              segments = segUrls;
            }
            // Sin BaseURL ni segmentos (Representation vacía): descartar.
            if (!b && !segments.length && !initUrl) continue;
            const q = {
              id: bandwidth || repId,
              label: bandwidth ? `${(Number(bandwidth) / 1e6).toFixed(1)} Mbps` : repId || "medio",
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
            videoQualities.push({ id: bandwidth || repId, label: bandwidth ? `${(Number(bandwidth) / 1e6).toFixed(1)} Mbps` : repId || "medio", url: new URL(b[1].trim(), base).href, kind: "video", initUrl: "", segments: [] });
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

      if (full.includes("#EXT-X-STREAM-INF")) {
        // Manifiesto maestro: variantes.
        // GRUPOS DE AUDIO (#EXT-X-MEDIA TYPE=AUDIO): los masters de X/Twitter
        // y YouTube Live separan el audio en pistas propias — las variantes
        // son SOLO VÍDEO. Elegarlas a ciegas produce vídeos mudos o, peor,
        // archivos de solo audio con nombre .mp4. Se resuelve el URI del
        // grupo y se marca cada variante con su audio para el mux.
        const audioGroups = new Map();
        const mediaRe = /^#EXT-X-MEDIA:([^\n]*)$/gm;
        let mm;
        while ((mm = mediaRe.exec(full))) {
          const attrs = mm[1];
          const a = (name) => (attrs.match(new RegExp(`${name}=("[^"]*"|[^,]*)`, "i")) || [])[1]?.replace(/^"|"$/g, "") || "";
          if (/^audio$/i.test(a("TYPE")) && a("URI")) {
            audioGroups.set(a("GROUP-ID") || a("NAME"), resolveRel(a("URI"), base));
          }
        }
        const qualities = [];
        const blocks = full.match(/#EXT-X-STREAM-INF:[^\n]*\n([^\n]+)/g) || [];
        for (const block of blocks) {
          const lines = block.split("\n");
          const attrs = lines[0];
          const bw = attrs.match(/BANDWIDTH=(\d+)/)?.[1];
          const codecs = (attrs.match(/CODECS="([^"]*)"/i) || [])[1] || "";
          const uri = lines[1]?.trim();
          if (!uri || uri.startsWith("#")) continue;
          // Variante de SOLO AUDIO (CODECS sin códec de vídeo, p.ej. solo
          // "mp4a.40.2"): no es una calidad de vídeo — se excluye.
          const hasVideoCodec = /avc1|avc3|hvc1|hev1|vp8|vp9|av01|mp4v/i.test(codecs);
          if (codecs && !hasVideoCodec) continue;
          const audioGroupId = (attrs.match(/AUDIO="([^"]*)"/i) || [])[1] || "";
          const audioUrl = audioGroupId && audioGroups.has(audioGroupId) ? audioGroups.get(audioGroupId) : null;
          qualities.push({
            id: bw || String(qualities.length),
            label: bw ? `${(Number(bw) / 1e6).toFixed(1)} Mbps` : "media",
            url: resolveRel(uri, base),
            audioUrl, // pista de audio separada (mux con companion si existe)
          });
        }
        if (!qualities.length && audioGroups.size) {
          // Master solo con audio (caso raro): declararlo, no fingir vídeo.
          for (const [, uri] of audioGroups) {
            qualities.push({ id: "audio", label: "solo audio", url: uri, audioUrl: null, audioOnly: true });
          }
        }
        return qualities.length ? { type: "hls-master", segments: qualities } : null;
      }
      // Manifiesto media: segmentos.
      //
      // `EXT-X-MAP` (init segment) va PRIMERO y es obligatorio para que un
      // fMP4 se pueda concatenar: los segmentos de medios de un CMAF no llevan
      // los metadatos (moov), están en el init. Omitirlo producía un archivo
      // sin cabecera, que algunos reproductores rechazan y otros reproducen sin
      // audio. RFC 8216 §4.3.2.2.
      const initAttr = (full.match(/^#EXT-X-MAP:([^\n]*)$/m) || [])[1] || "";
      const initRel = initAttr ? (/URI="([^"]*)"/.exec(initAttr) || [])[1] : "";
      const initUrl = initRel ? resolveRel(initRel, base) : "";

      const segs = (full.match(/^[^#\n][^\n]*$/gm) || [])
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"))
        .map((s) => new URL(s, base).href);

      const all = initUrl ? [initUrl, ...segs] : segs;
      return all.length ? { type: "hls", initUrl, segments: all } : null;
    } catch {
      return null;
    }
  }

  // Resuelve el MASTER de una variante capturada: los reproductores piden el
  // master y luego la variante; la URL capturada suele ser LA VARIANTE, que
  // no sabe que su audio va en una pista separada (#EXT-X-MEDIA). Se buscan
  // los m3u8 candidatos (los capturados en la página), se parsean y se
  // devuelve el que referencie esta variante, con su audioUrl.
  async function findHlsMaster(variantUrl, candidateUrls, max = 5) {
    let checked = 0;
    for (const u of candidateUrls) {
      if (!u || u === variantUrl || checked >= max) continue;
      checked++;
      try {
        const m = await parseManifest(u, "application/vnd.apple.mpegurl");
        if (!m || m.type !== "hls-master") continue;
        const base = variantUrl.split("?")[0].split("/").pop();
        const hit = (m.segments || []).find((q) => {
          const qn = (q.url || "").split("?")[0];
          return q.url === variantUrl || qn === variantUrl.split("?")[0] || qn.endsWith("/" + base);
        });
        if (hit) return { master: m, variant: hit };
      } catch {
        /* candidato ilegible: probar el siguiente */
      }
    }
    return null;
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

  // Nivel 7 (HONESTIDAD DE DESCARGA): sonda de bytes reales. Descarga los
  // primeros 64KB con Range y clasifica el contenido por magic bytes +
  // Content-Type. NINGUNA descarga se declara "completada" sin haber pasado
  // por aquí (o sin verificar el estado final del gestor de descargas).
  async function probeMedia(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-65535" }, signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok && res.status !== 206 && res.status !== 200) {
        return { ok: false, status: res.status, contentType: "", magic: "", total: 0, bytes: null };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const total = Number(res.headers.get("content-range")?.split("/")[1] || res.headers.get("content-length") || 0);
      return {
        ok: true,
        status: res.status,
        contentType: (res.headers.get("content-type") || "").toLowerCase(),
        magic: detectMagic(bytes),
        total,
        bytes,
      };
    } catch {
      clearTimeout(timer);
      return { ok: false, status: 0, contentType: "", magic: "", total: 0, bytes: null };
    }
  }

  // Veredicto del contenido sondeado: "media" | "manifest" | "html" | "unknown".
  // "html" es la señal de anti-hotlink / URL expirada (página de error).
  function mediaVerdict(probe) {
    if (!probe) return "unknown";
    const ct = probe.contentType || "";
    if (/text\/html|application\/xhtml/i.test(ct)) return "html";
    if (/mpegurl|dash\+xml/i.test(ct)) return "manifest";
    if (probe.magic) {
      if (probe.magic === "hls" || probe.magic === "dash") return "manifest";
      return "media";
    }
    // Sin magic (formatos sin firma en detectMagic, p.ej. .m4s): aceptar solo
    // si el servidor declara un Content-Type de medios real.
    if (/^(video|audio|image)\//.test(ct) || ct === "application/mp4" || ct === "video/iso.segment") return "media";
    return "unknown";
  }

  // --- Detección REAL de pista de audio (honestidad del botón "extraer audio") ---
  // Los GIF de X/Twitter son MP4 SIN pista de audio: extraer MP3 de ellos
  // produce un archivo vacío o un error críptico. Aquí se decide leyendo la
  // estructura del contenedor (no conjeturas):
  //   MP4: caja moov (completa en el rango descargado) → cajas hdlr →
  //        handler_type "soun" = hay audio.
  //   WebM/MKV (EBML): CodecID A_* en los primeros MB = hay audio.
  // Devuelve: true (hay audio) | false (NO hay) | null (no se pudo determinar:
  // se permite el intento y el procesador decidirá).
  // Refactor de hasAudioTrack: el mismo parseo expone los TIPOS DE PISTA
  // (handlers hdlr del moov) — {"audio": bool, "video": bool} | null. Lo
  // necesita la clasificación de relaciones: una pista de audio de X/Twitter
  // (init .mp4 con solo "soun") debe ir a la pestaña de audio, no a vídeo.
  async function trackTypesOf(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-3145727" }, signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok && res.status !== 206 && res.status !== 200) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 16) return null;

      // WebM/MKV (EBML): CodecID A_* / V_* como texto ASCII en los Tracks.
      if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        const head = asciiOf(buf.subarray(0, Math.min(buf.length, 1024 * 1024)));
        const audio = /A_(AAC|OPUS|VORBIS|FLAC|AC3|EAC3|DTS|MP3|PCM|MS\/ACM)/.test(head);
        const video = /V_(VP8|VP9|AV1|MSCOMP|AUTO)/.test(head);
        return audio || video ? { audio, video } : null;
      }

      // MP4: recorrido correcto de cajas top-level hasta moov.
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      let off = 0;
      let moov = null;
      while (off + 8 <= buf.byteLength) {
        let size = dv.getUint32(off);
        const type = asciiOf(buf.subarray(off + 4, off + 8));
        let headerLen = 8;
        if (size === 1) {
          if (off + 16 > buf.byteLength) break;
          size = Number(dv.getBigUint64(off + 8));
          headerLen = 16;
        } else if (size === 0) {
          size = buf.byteLength - off;
        }
        if (size < headerLen) break;
        if (type === "moov") {
          if (off + size <= buf.byteLength) moov = buf.subarray(off + headerLen, off + size);
          break;
        }
        off += size;
      }
      if (!moov) return null;

      const handlers = [];
      (function walkBoxes(bytes, depth) {
        const d2 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let o = 0;
        while (o + 8 <= bytes.byteLength) {
          let size = d2.getUint32(o);
          const type = asciiOf(bytes.subarray(o + 4, o + 8));
          let headerLen = 8;
          if (size === 1) {
            if (o + 16 > bytes.byteLength) break;
            size = Number(d2.getBigUint64(o + 8));
            headerLen = 16;
          } else if (size === 0) {
            size = bytes.byteLength - o;
          }
          if (size < headerLen || o + size > bytes.byteLength) break;
          if (type === "hdlr" && o + headerLen + 8 <= o + size) {
            handlers.push(asciiOf(bytes.subarray(o + headerLen + 8, o + headerLen + 12)));
          } else if (depth < 4 && /^(trak|mdia|minf|stbl|edts)$/.test(type)) {
            walkBoxes(bytes.subarray(o + headerLen, o + size), depth + 1);
          }
          o += size;
        }
      })(moov, 0);

      if (!handlers.length) return null;
      return { audio: handlers.includes("soun"), video: handlers.includes("vide") };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  async function hasAudioTrack(url) {
    const t = await trackTypesOf(url);
    if (!t || !t.audio && !t.video) return null;
    return t.audio;
  }

  function asciiOf(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
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
  const OperantMedia = {
    classifyExt,
    extOf,
    fetchHead,
    fetchRangeHead,
    detectMagic,
    parseManifest,
    isUrlAlive,
    classifyDownload,
    probeMedia,
    mediaVerdict,
    hasAudioTrack,
    trackTypesOf,
    findHlsMaster,
    EXT: EXT_PATH,
    DIRECT_VIDEO,
    DIRECT_IMAGE,
    DIRECT_AUDIO,
    DIRECT_FILE,
  };

  global.OperantMedia = OperantMedia;
  global.NTMedia = OperantMedia; // alias de compatibilidad
  // Soporte dual: script tag clásico (global) o ES module (export).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = OperantMedia;
  }
  if (typeof exports !== "undefined" && typeof exports !== "function") {
    exports.OperantMedia = OperantMedia;
    exports.NTMedia = OperantMedia;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

// Export explícito para import ES module (service worker).
export const OperantMedia = globalThis.OperantMedia;
export const NTMedia = globalThis.OperantMedia;
export default globalThis.OperantMedia;
