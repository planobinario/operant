// hls-fast.js — Ruta rápida HLS 100% en navegador (paridad FetchV, sin host nativo).
// Pipeline: parseo completo del m3u8 → fetch paralelo de segmentos (concurrencia
// acotada + reintentos) → descifrado AES-128 con WebCrypto → concatenación
// binaria fMP4/TS. Sin chrome.*: lógica pura con fetch/crypto inyectables, así
// el panel y el service worker ejecutan el MISMO motor y es testeable en Node.
//
// Por qué funciona sin ffmpeg: el HLS moderno es fMP4 (EXT-X-MAP + segmentos
// .m4s) y la concatenación binaria de init+segmentos produce un MP4
// fragmentado válido; MPEG-TS está diseñado para concatenarse tal cual. El
// cifrado AES-128 (sin DRM) se descifra en JS: la clave es otro recurso HTTPS
// y el IV viene en el manifiesto o es el media sequence del segmento.
//
// Lives (ventana deslizante): si el manifiesto no lleva EXT-X-ENDLIST, el
// motor entra en modo live — sondeo periódico del playlist, dedupe por media
// sequence absoluta y grabación hasta ENDLIST, parada del usuario o límites
// (bytes/duración). Los IV derivados de la secuencia absoluta siguen siendo
// correctos entre ventanas (RFC 8216 §5.2).
//
// Limites asumidos (documentados, NO silenciados):
//   · SAMPLE-AES y demás DRM no soportados: se falla con un mensaje explícito en
//     vez de entregar basura cifrada.
//   · Pistas separadas (audio/vídeo) requieren remux: eso sigue siendo trabajo
//     del host nativo (ffmpeg).
//   · EXT-X-DISCONTINUITY se MARCA (`discontinuity` por segmento y
//     `hasDiscontinuity` en el manifest) para que el ensamblador no concatene a
//     ciegas datos con línea de tiempo incompatible.

(function (global) {
  "use strict";

  // --- Estado persistente del MOTOR (no del parseo) ---
  //
  // Los cursores de byterange tienen que sobrevivir entre llamadas a parseMedia.
  // En live, la playlist se re-parsea cada `TARGETDURATION/2` segundos: con un
  // cursor local al parseo, cada pasada reiniciaba el offset a 0 y la
  // concatenación usaba bytes equivocados de un recurso que SÍ devolvía la
  // longitud pedida — es decir, corrupción silenciosa, el peor modo de fallo
  // posible.
  const engineState = {
    /** url -> siguiente offset libre para un BYTERANGE sin offset explícito */
    byterangeCursors: new Map(),
    /** borra el estado al terminar una descarga (llamado desde clearKeyCache) */
    reset() {
      engineState.byterangeCursors.clear();
    },
  };

  // --- Utilidades de URL ---

  function resolveUrl(uri, baseUrl) {
    try {
      return new URL(uri, baseUrl).href;
    } catch {
      return uri;
    }
  }

  // IV hex ("0xABC…") a Uint8Array(16). El IV de HLS siempre cabe en 16 bytes
  // y se alinea a la derecha (los bytes altos a 0).
  function parseHexIv(str) {
    const hex = String(str || "").replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "");
    if (!hex) return null;
    const out = new Uint8Array(16);
    const byteLen = Math.min(16, Math.floor(hex.length / 2));
    for (let i = 0; i < byteLen; i++) {
      out[16 - byteLen + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return out;
  }

  // Media sequence como IV (RFC 8216 §5.2): entero sin signo de 64 bits
  // big-endian alineado a la derecha en un buffer de 16 bytes.
  function sequenceIv(seq) {
    const out = new Uint8Array(16);
    // `BigInt(NaN)` LANZA, y antes de este blindaje un `#EXT-X-MEDIA-SEQUENCE`
    // malformado ("abc", vacío, o ausente) tumbaba el parseo del playlist
    // entero — y con él la descarga. Ahora un IV no numérico degrada a 0,
    // que es lo que hacen el resto de reproductores: mejor un segmento
    // descifrado mal que ninguna descarga.
    const n = Number(seq);
    const safe = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    let v = BigInt(safe);
    for (let i = 15; i >= 8; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  // --- Parser de master playlist (#EXT-X-STREAM-INF) ---
  // Devuelve { variants: [{bandwidth, resolution, codecs, url, audioUrl}] } o
  // null si no es un master. Los masters con audio separado (X/Twitter,
  // YouTube Live) declaran grupos #EXT-X-MEDIA TYPE=AUDIO y variantes SOLO
  // VÍDEO: cada variante lleva su audioUrl de grupo para el mux; las
  // variantes de solo audio se devuelven marcadas (audioOnly) para excluirse
  // de la selección automática.
  function parseMaster(text, baseUrl) {
    // Guarda de entrada: `text.includes` sobre null/undefined lanza TypeError y
    // tumba el parseo entero. Un playlist vacío o corrupto debe ser "no es un
    // master", nunca una excepción.
    if (!text || typeof text !== "string") return null;
    if (!text.includes("#EXT-X-STREAM-INF")) return null;
    const audioGroups = new Map();
    const mediaRe = /^#EXT-X-MEDIA:([^\n]*)$/gm;
    let mm;
    while ((mm = mediaRe.exec(text))) {
      const attrs = mm[1];
      const attr = (name) => {
        const m = attrs.match(new RegExp(`${name}=("[^"]*"|[^,]*)`, "i"));
        return m ? m[1].replace(/^"|"$/g, "") : "";
      };
      if (/^audio$/i.test(attr("TYPE")) && attr("URI")) {
        audioGroups.set(attr("GROUP-ID") || attr("NAME"), resolveUrl(attr("URI"), baseUrl));
      }
    }
    const variants = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const attrs = line.slice("#EXT-X-STREAM-INF:".length);
      const attr = (name) => {
        const m = attrs.match(new RegExp(`${name}=("[^"]*"|[^,]*)`, "i"));
        return m ? m[1].replace(/^"|"$/g, "") : "";
      };
      // La URI del variante es la siguiente línea que no empieza por '#'.
      let uri = "";
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l || l.startsWith("#")) continue;
        uri = l;
        break;
      }
      if (!uri) continue;
      const bandwidth = Number(attr("BANDWIDTH")) || Number(attr("AVERAGE-BANDWIDTH")) || 0;
      const codecs = attr("CODECS");
      const audioGroupId = attr("AUDIO");
      const hasVideoCodec = /avc1|avc3|hvc1|hev1|vp8|vp9|av01|mp4v/i.test(codecs);
      variants.push({
        bandwidth,
        resolution: attr("RESOLUTION"),
        codecs,
        url: resolveUrl(uri, baseUrl),
        audioUrl: audioGroupId && audioGroups.has(audioGroupId) ? audioGroups.get(audioGroupId) : null,
        audioOnly: !!codecs && !hasVideoCodec,
      });
    }
    return variants.length ? { variants } : null;
  }

  // --- Parser de media playlist (segmentos reales) ---
  // Devuelve { segments, map, mediaSequence, encrypted, live, durationSec,
  // targetDuration }. Cada segmento lleva SU key y SU map activos (los tags
  // aplican hacia abajo hasta el siguiente), y su media sequence absoluta
  // (base para el IV por defecto). BYTERANGE soportado con offset acumulativo
  // por recurso.
  function parseMedia(text, baseUrl) {
    // Misma guarda que parseMaster: null/undefined no es un playlist, es un
    // "no se puede procesar", y debe devolverse como tal.
    if (!text || typeof text !== "string") return null;
    if (!text.includes("#EXTINF") && !text.includes("#EXT-X-MAP")) return null;
    const segments = [];
    let mediaSequence = 0;
    let live = true;
    let durationSec = 0;
    let targetDuration = null;
    let currentKey = null; // {method, uri, iv} | null (METHOD=NONE)
    let currentMap = null; // {url, byterange} | null
    let pendingDuration = null;
    let pendingByterange = null; // {length, offset} del próximo segmento
    let pendingDiscontinuity = false;
    // Cursores de byterange IMPERSISTENTES entre llamadas: un segmento con
    // BYTERANGE sin offset debe continuar donde acabó el anterior de la misma
    // URI. En live la playlist se re-parsea cada pocos segundos, así que un
    // cursor local al parseo reiniciaría a 0 en cada pasada.
    const byterangeCursors = engineState.byterangeCursors;

    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = Number(line.split(":")[1]) || 0;
        continue;
      }
      if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        targetDuration = Number(line.split(":")[1]) || null;
        continue;
      }
      if (line.startsWith("#EXT-X-ENDLIST")) {
        live = false;
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        const v = parseFloat(line.slice(8).split(",")[0]);
        pendingDuration = Number.isFinite(v) ? v : null;
        continue;
      }
      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        const spec = line.slice(17);
        const m = spec.match(/(\d+)(?:@(\d+))?/);
        if (m) {
          pendingByterange = {
            length: Number(m[1]),
            offset: m[2] !== undefined ? Number(m[2]) : null, // null = acumulativo
          };
        }
        continue;
      }
      if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = line.slice(11);
        // Parser de atributos QUOTE-AWARE. El anterior era `NAME=([^,]+)`,
        // que corta en la primera coma: una URI de clave con query
        // (`URI="https://k/x?a=1,2"`) se truncaba, la petición de clave daba
        // 404 y TODA la descarga fallaba sin mensaje útil.
        const attr = (name) => {
          const re = new RegExp(`${name}=("([^"]*)"|[^,]*)`, "i");
          const m = re.exec(attrs);
          if (!m) return "";
          return m[2] !== undefined ? m[2] : String(m[1]).trim();
        };
        const method = (attr("METHOD") || "").toUpperCase();
        if (method === "NONE") {
          currentKey = null;
        } else if (method === "AES-128") {
          const iv = parseHexIv(attr("IV"));
          currentKey = { method, uri: resolveUrl(attr("URI"), baseUrl), iv };
        } else if (method === "SAMPLE-AES" || method === "SAMPLE-AES-CTR") {
          throw new Error(
            "El stream usa SAMPLE-AES (DRM del reproductor): no es descifrable sin el host nativo/yt-dlp."
          );
        } else if (method === "") {
          // `#EXT-X-KEY:METHOD=` vacío no es una declaración de nada: es un tag
          // malformado, no un cifrado desconocido. Se ignora en lugar de tumbar
          // la descarga, que es lo que hacía el `if/else if` sin `else`.
          currentKey = null;
        } else {
          // Método NOMBADO y no soportado (AES-128-LWR, o cualquier futuro
          // añadido a la spec). Antes la cadena `if/else if` no tenía `else`,
          // así que `currentKey` conservaba la clave ANTERIOR: se descargaba
          // con una clave que no correspondía (o sin descifrar) informando
          // `encrypted: true` como si todo estuviera bien.
          //
          // Aquí lo honesto es fallar: es imposible saber cómo descifrarlo, y
          // entregar bytes indescifrables sería peor que un error.
          throw new Error(
            `El stream usa un método de cifrado no soportado (${method}): no es descifrable.`
          );
        }
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = line.slice(11);
        const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1] || "";
        if (!uri) continue;
        let mapByterange = null;
        // BYTERANGE admite la forma SIN comillas (`BYTERANGE=1000@500`), que
        // es legal en una lista de atributos HLS y que el regex anterior
        // (exigía comillas) no veía: se descargaba el recurso entero y se
        // concatenaba la rebanada equivocada.
        const br = attrs.match(/BYTERANGE="?(\d+)(?:@(\d+))?"?/i);
        if (br) {
          mapByterange = { length: Number(br[1]), offset: br[2] !== undefined ? Number(br[2]) : null };
        }
        currentMap = { url: resolveUrl(uri, baseUrl), byterange: mapByterange };
        continue;
      }
      if (line.startsWith("#EXT-X-DISCONTINUITY")) {
        // RFC 8216 §4.3.2.3: un corte de discontinuidad reinicia los timescales
        // y la línea de tiempo. Los segmentos anteriores y posteriores NO son
        // concatenables byte a byte: hacerlo produce DTS no monótonos y un
        // archivo que muchos reproductores se niegan a abrir.
        //
        // Se registra en el segmento para que quien ensamble pueda poner un
        // limite (nuevo fichero, o avisar) en lugar de generar basura.
        pendingDiscontinuity = true;
        continue;
      }
      if (line.startsWith("#")) continue; // cualquier otro tag: ignorar
      // Línea de recurso: el segmento pendiente.
      const segUrl = resolveUrl(line, baseUrl);
      let byterange = null;
      if (pendingByterange) {
        let offset = pendingByterange.offset;
        if (offset === null || offset === undefined) {
          // Offset implícito: RFC 8216 §4.3.2.2 dice que empieza donde acabó el
          // segmento anterior DE LA MISMA URI. `byterangeCursors` es estado
          // del ENGINE, no del parseo: antes vivía en un Map local que se
          // recreaba en cada llamada, y en live (que re-parsea la playlist
          // cada pocos segundos) el offset volvía a 0 siempre. El Range
          // resultante era VÁLIDO y la longitud coincidía, así que los bytes
          // equivocados se concatenaban sin ningún error.
          const cursor = byterangeCursors.get(segUrl);
          offset = cursor === undefined ? 0 : cursor;
        }
        byterangeCursors.set(segUrl, offset + pendingByterange.length);
        // FALTA QUE SE ASIGNE. El offset se calculaba y el cursor se
        // actualizaba, pero `byterange` se quedaba en `null` para siempre: la
        // cabecera `Range` NO se enviaba, `fetchResource` pedía el recurso
        // COMPLETO en cada segmento y devolvía un buffer mucho mayor que el
        // esperado. En una playlist con BYTERANGE el resultado era el mismo
        // fichero concatenado N veces, sin ningún error. El chequeo de
        // longitud de `fetchResource` tampoco se activaba nunca, porque
        // `byterange` era null.
        byterange = { offset, length: pendingByterange.length };
        pendingByterange = null;
      }
      segments.push({
        url: segUrl,
        seq: mediaSequence + segments.length,
        duration: pendingDuration,
        byterange,
        key: currentKey ? { method: currentKey.method, uri: currentKey.uri, iv: currentKey.iv } : null,
        map: currentMap ? { url: currentMap.url, byterange: currentMap.byterange } : null,
        discontinuity: pendingDiscontinuity,
      });
      pendingDiscontinuity = false;
      if (pendingDuration) durationSec += pendingDuration;
      pendingDuration = null;
    }

    return {
      segments,
      map: currentMap, // el MAP activo al final (los segmentos llevan el suyo)
      mediaSequence,
      encrypted: segments.some((s) => s.key),
      live,
      durationSec,
      targetDuration,
      // Hay un corte de discontinuidad en algún punto: el ensamblador tiene que
      // saberlo, porque a partir de ahí los segmentos no son concatenables.
      hasDiscontinuity: segments.some((s) => s.discontinuity),
    };
  }

  // --- Descifrado AES-128 (WebCrypto) ---

  const keyCache = new Map(); // uri -> Uint8Array(16)

  async function fetchKey(key, fetchImpl, fetchResource) {
    if (keyCache.has(key.uri)) return keyCache.get(key.uri);
    // La clave se descarga por el MISMO wrapper que los segmentos, con su
    // fallback de credenciales y sus reintentos. Antes usaba `fetchImpl`
    // directamente con credentials:"include" y sin reintento: un endpoint de
    // clave en un CDN sin `Access-Control-Allow-Credentials` moría en el
    // primer intento con un 4xx opaco, y el resto del stream sí funcionaba —
    // un fallo que solo se manifestaba al final de una descarga completa.
    const res =
      fetchResource && typeof fetchResource.fetchUrl === "function"
        ? await fetchResource.fetchUrl(key.uri)
        : await fetchImpl(key.uri, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`No se pudo obtener la clave AES (${res.status}): ${key.uri}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== 16) throw new Error(`La clave AES mide ${buf.length} bytes (esperados 16): ${key.uri}`);
    keyCache.set(key.uri, buf);
    return buf;
  }

  async function decryptAes128(keyBytes, ivBytes, data) {
    const cryptoObj = globalThis.crypto;
    const key = await cryptoObj.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
    const plain = await cryptoObj.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, data);
    return new Uint8Array(plain);
  }

  // --- Piezas compartidas entre el motor VOD y el live ---

  // Resuelve master → media playlist (profundidad acotada para los raros
  // masters de masters). Devuelve { playlistUrl, text, variant }.
  // Las variantes de SOLO AUDIO se saltan en la selección automática (no son
  // vídeo); si la variante elegida lleva audio en grupo separado, se devuelve
  // en variant.audioUrl para que el llamador decida (mux con companion).
  async function resolveVariantPlaylist({ url, quality = "best", doFetch, throwIfAborted }) {
    let playlistUrl = url;
    let text = "";
    let variant = null;
    for (let depth = 0; depth < 4; depth++) {
      throwIfAborted();
      const res = await doFetch(playlistUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`No se pudo leer el manifiesto (HTTP ${res.status}): ${playlistUrl}`);
      text = await res.text();
      if (!text.includes("#EXTM3U")) {
        throw new Error("La URL no es un manifiesto HLS (falta #EXTM3U).");
      }
      const master = parseMaster(text, playlistUrl);
      if (!master) break;
      if (!master.variants.length) throw new Error("Master playlist sin variantes.");
      const videoVariants = master.variants.filter((v) => !v.audioOnly);
      const pool = videoVariants.length ? videoVariants : master.variants;
      let chosen;
      if (quality === "best") {
        chosen = pool.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
      } else {
        chosen = pool.find((v) => String(v.bandwidth) === String(quality)) || pool[0];
      }
      variant = chosen;
      playlistUrl = chosen.url;
    }
    return { playlistUrl, text, variant };
  }

  // Fábrica del fetcher de recursos (segmentos/init) con Range para
  // BYTERANGE, reintentos con backoff y abort cooperativo.
  function createFetchResource({ doFetch, retries = 2, isAborted }) {
    // La descarga de la clave usa este mismo wrapper (con su fallback de
    // credenciales y sus reintentos). Se le expone como propiedad para que
    // fetchKey pueda recibirlo sin cambiar su firma pública.
    const resource = async (segUrl, byterange) => {
      const headers = {};
      if (byterange) headers.Range = `bytes=${byterange.offset}-${byterange.offset + byterange.length - 1}`;
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (isAborted()) throw new Error("Descarga cancelada.");
        try {
          const res = await doFetch(segUrl, byterange ? { headers, cache: "no-store" } : {});
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          if (byterange && buf.byteLength !== byterange.length) {
            throw new Error(`BYTERANGE incompleto (${buf.byteLength}/${byterange.length})`);
          }
          return buf;
        } catch (e) {
          lastErr = e;
          if (isAborted()) throw new Error("Descarga cancelada.");
          if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      throw new Error(`Segmento fallido tras ${retries + 1} intentos: ${segUrl} (${String(lastErr?.message || lastErr)})`);
    };
    // Petición de una URL suelta (la clave AES) por el mismo camino: mismo
    // fallback de credenciales, mismos reintentos, mismo mensaje de error.
    resource.fetchUrl = async (u) => {
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (isAborted()) throw new Error("Descarga cancelada.");
        try {
          const res = await doFetch(u, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res;
        } catch (e) {
          lastErr = e;
          if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      throw new Error(`Recurso fallido tras ${retries + 1} intentos: ${u} (${String(lastErr?.message || lastErr)})`);
    };
    return resource;
  }

  // Detección de contenedor: fMP4 si hay EXT-X-MAP o el primer segmento
  // empieza por ftyp/styp; si no, MPEG-TS (sync byte 0x47).
  function sniffContainer(hasMap, firstBytes) {
    if (hasMap) return "fmp4";
    if (firstBytes && firstBytes.length >= 8) {
      const brand = String.fromCharCode(firstBytes[4], firstBytes[5], firstBytes[6], firstBytes[7]);
      if (brand === "ftyp" || brand === "styp") return "fmp4";
    }
    return "ts";
  }

  // Descarga y descifra un segmento aplicando su EXT-X-MAP (init) y su KEY
  // AES-128 (IV explícito o media sequence absoluta).
  //
  // Devuelve `{ media, init }`: el init se devuelve JUNTO a su segmento en vez
  // de acumularlo aparte. Antes todos los init se volcaban en una lista global
  // que luego se concatenaba AL PRINCIPIO, en orden de finalización de descarga
  // (nondeterminista con concurrencia). Eso rompe en cuanto hay más de un
  // periodo: los `trex` del init del periodo 0 se aplicaban a segmentos del
  // periodo N, y el archivo resultante no se abría.
  async function processSegment(seg, fetchResource, doFetch, mapBuffers) {
    let buf = await fetchResource(seg.url, seg.byterange);
    if (seg.key) {
      const keyBytes = await fetchKey(seg.key, doFetch, fetchResource);
      const iv = seg.key.iv || sequenceIv(seg.seq);
      buf = await decryptAes128(keyBytes, iv, buf);
    }
    let init = null;
    if (seg.map) {
      // El init segment del MAP activo se descarga con su BYTERANGE propio (el
      // parser ya resolvió offset acumulativo y longitud).
      //
      // En la cache va la PROMESA, no el buffer resuelto: con concurrencia >1,
      // dos segmentos del mismo periodo se comprobaban mutuamente el `has()`
      // ANTES de que ninguno hubiera terminado y ambos descargaban el init.
      let pending = mapBuffers.get(seg.map.url);
      if (!pending) {
        pending = fetchResource(seg.map.url, seg.map.byterange);
        mapBuffers.set(seg.map.url, pending);
      }
      init = await pending;
    }
    return { media: buf, init, discontinuity: !!seg.discontinuity };
  }

  // --- Descarga orquestada (VOD) ---

  // opts: { url, quality="best", fetchImpl, concurrency=6, retries=2,
  //         onProgress(done,total,bytes), beforeFetch(url), signal,
  //         maxSegments=5000, maxBytes=2GB, allowLive=true }
  // Devuelve { blob, kind: "fmp4"|"ts", segments, bytes, durationSec, variant }.
  // Si el manifiesto no lleva ENDLIST (live/event) y allowLive, delega en
  // downloadHlsLive: el VOD normal no cambia de comportamiento.
  async function downloadHls(opts) {
    const {
      url,
      quality = "best",
      fetchImpl = (u, o) => fetch(u, o),
      concurrency = 6,
      retries = 2,
      onProgress = null,
      beforeFetch = null,
      signal = null,
      maxSegments = 5000,
      maxBytes = 2 * 1024 * 1024 * 1024,
      allowLive = true,
      requireAudio = false,
    } = opts || {};

    const doFetch = async (u, o = {}) => {
      if (beforeFetch) await beforeFetch(u);
      try {
        return await fetchImpl(u, { credentials: "include", cache: "force-cache", ...o });
      } catch (e) {
        // Petición credencial cross-origin rechazada (CDN sin CORS de
        // cookies): reintentar sin credenciales antes de rendirse.
        return await fetchImpl(u, { credentials: "omit", cache: "no-store", ...o });
      }
    };

    const aborted = () => signal && signal.aborted;
    const throwIfAborted = () => {
      if (aborted()) throw new Error("Descarga cancelada.");
    };

    const { playlistUrl, text, variant } = await resolveVariantPlaylist({ url, quality, doFetch, throwIfAborted });

    const media = parseMedia(text, playlistUrl);
    if (!media || !media.segments.length) {
      throw new Error("El manifiesto no contiene segmentos descargables.");
    }

// DETECCIÓN TEMPRANA DE AUDIO: el init segment (EXT-X-MAP) contiene el
    // moov con los trak - handler "soun" = la variante lleva audio. Los
    // masters con audio separado (X/Twitter) sirven variantes SOLO VÍDEO:
    // sin esta comprobación, la descarga produce un vídeo mudo "exitoso".
    // Con requireAudio, falla ANTES de gastar la descarga.
    //
    // El init se pide por el MISMO `fetchResource` y la MISMA cache que usarán
    // los segmentos. Antes hacía una petición propia con `fetchImpl`, así que
    // el mismo recurso se descargaba DOS veces en toda la operación.
    const fetchResource = createFetchResource({ doFetch, retries, isAborted: aborted });
    const mapBuffers = new Map(); // mapUrl -> Promise<Uint8Array> (cache de init)
    let hasAudio = null;
    if (media.map) {
      try {
        const asciiOf = (u8) => {
          let s = "";
          const step = 0x8000;
          for (let i = 0; i < u8.length; i += step) s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
          return s;
        };
        let pending = mapBuffers.get(media.map.url);
        if (!pending) {
          pending = fetchResource(media.map.url, media.map.byterange);
          mapBuffers.set(media.map.url, pending);
        }
        hasAudio = asciiOf(await pending).includes("soun");
      } catch {
        hasAudio = null; // no determinar: no bloquear
      }
    }
    if (requireAudio && hasAudio === false) {
      throw new Error("Esta variante no incluye pista de audio (stream con audio separado): se necesita el companion para unir vídeo+audio.");
    }

    // Live/event (sin ENDLIST): ventana deslizante → modo grabación. Se pasa
    // la media playlist ya parseada para no perder la ventana actual.
    if (media.live && allowLive) {
      return downloadHlsLive({ ...opts, initialPlaylistUrl: playlistUrl, initialMedia: media, variant });
    }

    if (media.segments.length > maxSegments) {
      throw new Error(
        `El stream tiene ${media.segments.length} segmentos (máx. ${maxSegments}). Es probable que sea un directo en emisión: usa el modo grabación o yt-dlp.`
      );
    }

    const total = media.segments.length;
    const buffers = new Array(total);
    const inits = new Array(total); // init POR SEGMENTO (o null)
    let done = 0;
    let bytes = 0;
    let firstBytes = null; // para detectar el contenedor por magic bytes

    const runSegment = async (seg, index) => {
      const { media: buf, init } = await processSegment(seg, fetchResource, doFetch, mapBuffers);
      buffers[index] = buf;
      inits[index] = init;
      // `firstBytes` debe ser el del SEGMENTO 0, no el del primero que termine:
      // con concurrencia >1 ganaba el que se descargaba antes, y el resultado
      // (fMP4 vs TS) era NONDETERMINISTA para la misma URL. Además se miran
      // bytes de un segmento de medios, no de un init, así que la marca que
      // importa (`ftyp`/`styp`) solo aparece en los primeros.
      if (index === 0 && buf.length >= 4) firstBytes = buf.slice(0, 12);
      bytes += buf.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`El stream supera el límite de ${(maxBytes / 1073741824).toFixed(0)} GB — abortado.`);
      }
      done++;
      if (onProgress) {
        try {
          onProgress(done, total, bytes);
        } catch {
          /* el callback de progreso no debe tumbar la descarga */
        }
      }
    };

    // Cola de workers acotada: exactamente `concurrency` en vuelo, con fallo
    // rápido (el primer error cancela el resto sin descargas huérfanas).
    let nextIndex = 0;
    let fatal = null;
    const worker = async () => {
      while (true) {
        if (fatal) return;
        const i = nextIndex++;
        if (i >= total) return;
        try {
          await runSegment(media.segments[i], i);
        } catch (e) {
          if (!fatal) fatal = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    if (fatal) throw fatal;
    throwIfAborted();

    const kind = sniffContainer(media.map, firstBytes);

    // Concatenación binaria EN ORDEN DE REPRODUCCIÓN, con el init de cada
    // periodo en su sitio.
    //
    // Antes se volcaban TODOS los init al principio (y en orden de FINALIZACIÓN
    // de descarga, que con concurrencia es arbitrario) y luego todos los
    // segmentos. Con un solo periodo funcionaba por casualidad; con dos, los
    // `trex` del init equivocado se aplicaban a los segmentos del otro periodo
    // y el MP4 resultante no se abría. Ahora el init precede a su primer
    // segmento y se reutiliza (cache) en el resto del periodo.
    const parts = [];
    if (kind === "fmp4") {
      let lastInit = null;
      for (let i = 0; i < buffers.length; i++) {
        const init = inits[i];
        if (init && init !== lastInit) {
          parts.push(init);
          lastInit = init;
        }
        parts.push(buffers[i]);
      }
    } else {
      for (const b of buffers) parts.push(b);
    }
    const blob = new Blob(parts, { type: kind === "fmp4" ? "video/mp4" : "video/mp2t" });

    return {
      blob,
      kind,
      segments: total,
      bytes,
      durationSec: media.durationSec,
      encrypted: media.encrypted,
      live: media.live,
      variant,
      hasAudio,
      hasDiscontinuity: !!media.hasDiscontinuity,
    };
  }

  // --- Modo live: ventana deslizante con sondeo y parada del usuario ---

  // opts: los de downloadHls más { maxDurationSec=4h, stallRounds=4 }.
  // onProgress recibe ({ bytes, segments, durationSec, elapsedSec }).
  // La petición de parada (signal) NO es un error: finaliza y entrega lo
  // grabado hasta el momento (semántica "Parar y guardar").
  // Devuelve el mismo shape que downloadHls con live: true.
  async function downloadHlsLive(opts) {
    const {
      url,
      quality = "best",
      fetchImpl = (u, o) => fetch(u, o),
      concurrency = 6,
      retries = 2,
      onProgress = null,
      beforeFetch = null,
      signal = null,
      maxBytes = 2 * 1024 * 1024 * 1024,
      maxDurationSec = 4 * 60 * 60,
      stallRounds = 4,
      pollIntervalMs = null, // override de test; si no, TARGETDURATION/2 (mín. 4 s)
      initialPlaylistUrl = null, // media playlist ya resuelta por downloadHls
      initialMedia = null, // primer parse (semilla de la ventana actual)
    } = opts || {};

    const doFetch = async (u, o = {}) => {
      if (beforeFetch) await beforeFetch(u);
      try {
        return await fetchImpl(u, { credentials: "include", cache: "force-cache", ...o });
      } catch (e) {
        // Credenciales cross-origin rechazadas: reintentar sin cookies.
        return await fetchImpl(u, { credentials: "omit", cache: "no-store", ...o });
      }
    };
    const aborted = () => signal && signal.aborted;
    const throwIfAborted = () => {
      if (aborted()) throw new Error("Descarga cancelada.");
    };
    const fetchResource = createFetchResource({ doFetch, retries, isAborted: aborted });

    // 1) Playlist: reutiliza la media resuelta por downloadHls (evita perder
    //    la ventana actual al re-leer) o resuelve variantes desde cero.
    let playlistUrl = initialPlaylistUrl || url;
    let variant = null;
    let initialText = null;
    if (!initialMedia) {
      const resolved = await resolveVariantPlaylist({ url, quality, doFetch, throwIfAborted });
      playlistUrl = resolved.playlistUrl;
      variant = resolved.variant;
      // El texto leído NO se descartaba: se pedía el manifest y luego el
      // sondeador volvía a pedirlo, sin parsear el primero. Los segmentos que
      // solo aparecían en esa primera foto (ventana corta, o un playlist que ya
      // no cambia) nunca se encolaban, y la grabación empezaba en el siguiente
      // ciclo: se perdían segmentos del principio sin ningún aviso.
      initialText = resolved.text;
    }

    // 2) Estado del live: dedupe por media sequence absoluta.
    const seen = new Set(); // seq ya encolados
    const buffers = new Map(); // seq -> Uint8Array
    const liveInits = new Map(); // seq -> init segment de ese periodo (o null)
    const mapBuffers = new Map();
    const pending = []; // cola de segmentos pendientes de fetch
    let bytes = 0;
    let done = 0;
    let durationSeen = 0;
    let firstBytes = null;
    let encryptedSeen = false;
    let inFlight = 0; // segmentos en descarga ahora mismo
    let ended = false; // ENDLIST visto
    let stopping = false; // parada solicitada (signal)
    let stallRoundsSeen = 0;
    let emptyPolls = 0;
    let emptySinceMs = 0;
    const t0 = Date.now();

    // Semilla: la ventana actual ya parseada (por downloadHls o por el primer
    // manifest leído aquí) entra primero. Si no hay nada que sembrar y el
    // primer manifest traía ENDLIST, la grabación ya ha terminado.
    const seed = initialMedia || (initialText ? parseMedia(initialText, playlistUrl) : null);
    if (seed) {
      for (const seg of seed.segments) {
        if (seen.has(seg.seq)) continue;
        seen.add(seg.seq);
        durationSeen += seg.duration || 0;
        pending.push(seg);
      }
      if (seed.live === false && !initialMedia) {
        ended = true;
        stopping = true;
      }
    }

    let fatal = null;
    const reportProgress = () => {
      if (!onProgress) return;
      try {
        onProgress({
          bytes,
          segments: done,
          durationSec: durationSeen,
          elapsedSec: Math.round((Date.now() - t0) / 1000),
          live: true,
        });
      } catch {
        /* el callback de progreso no debe tumbar la grabación */
      }
    };

    const runSegment = async (seg) => {
      const { media: buf, init } = await processSegment(seg, fetchResource, doFetch, mapBuffers);
      buffers.set(seg.seq, buf);
      liveInits.set(seg.seq, init);
      // `firstBytes` debe salir del segmento de MENOR seq (el primero en el
      // tiempo), no del primero que termine de descargarse: con concurrencia
      // >1 el que ganaba la carrera era arbitrario y la detección de
      // contenedor (fMP4 vs TS) salía distinta en ejecuciones de la misma URL.
      if (firstBytes === null && buf.length >= 4) firstBytes = buf.slice(0, 12);
      if (seg.key) encryptedSeen = true;
      bytes += buf.byteLength;
      done++;
      if (bytes > maxBytes) {
        // Límite alcanzado: vaciar la cola y cerrar la grabación con orden
        // (no es un error fatal: se entrega lo grabado).
        ended = true;
        stopping = true;
        pending.length = 0;
        throw new Error(`El stream supera el límite de ${(maxBytes / 1073741824).toFixed(0)} GB — grabación cerrada.`);
      }
      reportProgress();
    };

    // 3) Workers continuos: drenan `pending` mientras haya vida en la grabación.
    const worker = async () => {
      while (true) {
        if (fatal) return;
        if (stopping && !pending.length) return;
        const seg = pending.shift();
        if (!seg) {
          if (ended) return;
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        inFlight++;
        try {
          await runSegment(seg);
        } catch (e) {
          // Parada del usuario o fin ordenado (límite/ENDLIST): cerrar worker
          // en silencio y entregar lo grabado. Solo un fallo real es fatal.
          // Se consulta el signal directamente: el poller puede seguir dormido.
          if (ended || stopping || aborted()) {
            reportProgress();
            return;
          }
          if (!fatal) fatal = e;
          return;
        } finally {
          inFlight--;
        }
      }
    };

    // 4) Sondeo del playlist: ventana deslizante con dedupe por seq.
    const poller = (async () => {
      let intervalMs = 4000;
      let first = true;
      while (!fatal) {
        if (aborted()) stopping = true;
        if (stopping) return;
        try {
          const res = await doFetch(playlistUrl, { cache: "no-store" });
          if (!res.ok) throw new Error(`No se pudo leer el manifiesto (HTTP ${res.status}): ${playlistUrl}`);
          const text = await res.text();
          const media = parseMedia(text, playlistUrl);
          if (!media || !media.segments.length) {
            // Playlist sin segmentos: puede ser un vaciado transitorio del
            // servidor. Con datos ya grabados, unas rondas secas cierran la
            // grabación; sin datos, se tolera hasta 30 s antes de rendirse.
            if (done > 0 && ++emptyPolls >= stallRounds) {
              stopping = true;
              return;
            }
            if (!emptySinceMs) emptySinceMs = Date.now();
            if (done === 0 && inFlight === 0 && pending.length === 0 && Date.now() - emptySinceMs > 30000) {
              throw new Error("El manifiesto no contiene segmentos descargables.");
            }
          } else {
            emptyPolls = 0;
            emptySinceMs = 0;
            if (media.targetDuration) {
              intervalMs = pollIntervalMs || Math.max(4000, Math.round((media.targetDuration * 1000) / 2));
            } else if (pollIntervalMs) {
              intervalMs = pollIntervalMs;
            }

            let added = 0;
            for (const seg of media.segments) {
              if (seen.has(seg.seq)) continue;
              seen.add(seg.seq);
              durationSeen += seg.duration || 0;
              if (!stopping) pending.push(seg);
              added++;
            }
            if (media.live === false) ended = true;
            if (ended) {
              // ENDLIST: drenar lo pendiente y finalizar.
              stopping = true;
              return;
            }
            // Stream sin fin y sin datos nuevos tras la primera ventana: o es un
            // VOD mal etiquetado o el evento aún no emite. Tras stallRounds
            // rondas sin novedad y con datos, finaliza con lo grabado.
            if (!first && added === 0 && !pending.length && done > 0) {
              stallRoundsSeen++;
              if (stallRoundsSeen >= stallRounds) {
                stopping = true;
                return;
              }
            } else {
              stallRoundsSeen = 0;
            }
            first = false;

            if (durationSeen > maxDurationSec) {
              stopping = true;
              return;
            }
          }
        } catch (e) {
          if (aborted()) {
            stopping = true;
            return;
          }
          // Un fallo puntual del sondeo no mata la grabación: reintentará en
          // el siguiente intervalo. Si el playlist ha dejado de existir, la
          // grabación sigue con lo que hay en cola y el usuario decide.
          if (done === 0 && pending.length === 0) {
            fatal = e;
            return;
          }
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    })();

    await Promise.all([poller, ...Array.from({ length: concurrency }, worker)]);
    if (fatal) throw fatal;

    // 5) Ensamblado en orden de reproduccion (por seq absoluta).
    const orderedKeys = [...buffers.keys()].sort((a, b) => a - b);
    const ordered = orderedKeys.map((k) => buffers.get(k));
    // Los lives fMP4 declaran EXT-X-MAP (init); sin MAP se aplica el sniffing
    // de magic bytes sobre el primer segmento.
    const finalKind = mapBuffers.size > 0 ? "fmp4" : sniffContainer(false, firstBytes);

    // El init va justo antes de su primer segmento, no acumulado al principio.
    // Ver la nota equivalente en downloadHls: con mas de un periodo, volcar
    // todos los init delante mezclaba los `trex` de un periodo con los
    // segmentos de otro y el MP4 resultante no se abria.
    const parts = [];
    if (finalKind === "fmp4") {
      let lastInit = null;
      for (const seq of orderedKeys) {
        const init = liveInits.get(seq);
        if (init && init !== lastInit) {
          parts.push(init);
          lastInit = init;
        }
        parts.push(buffers.get(seq));
      }
    } else {
      for (const b of ordered) parts.push(b);
    }
    const blob = new Blob(parts, { type: finalKind === "fmp4" ? "video/mp4" : "video/mp2t" });

    reportProgress();
    return {
      blob,
      kind: finalKind,
      segments: done,
      bytes,
      durationSec: durationSeen,
      encrypted: encryptedSeen,
      live: true,
      variant,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    };
  }

  // Limpieza del estado del motor entre descargas.
  //
  // Los tokens AES expiran y no deben arrastrarse. Los cursores de byterange
  // TAMBIÉN: pertenecen a una descarga concreta, y mantenerlos haría que la
  // siguiente descarga de un recurso con byteranges empezara en el offset que
  // dejó la anterior (que puede estar en otro medio o ya haber caducado).
  function clearKeyCache() {
    keyCache.clear();
    engineState.reset();
  }

  // --- API pública ---
  const HLSFast = { parseMaster, parseMedia, downloadHls, downloadHlsLive, clearKeyCache, parseHexIv, sequenceIv };
  global.HLSFast = HLSFast;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = HLSFast;
  }
  if (typeof exports !== "undefined" && typeof exports !== "function") {
    exports.HLSFast = HLSFast;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

// Export explícito para import ES module (service worker / panel module).
export const HLSFast = globalThis.HLSFast;
export default globalThis.HLSFast;
