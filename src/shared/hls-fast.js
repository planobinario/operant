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
// Limites asumidos (documentados, no silenciados): SAMPLE-AES/DRM no soportado;
// pistas separadas (audio/vídeo) requieren remux — eso sigue siendo trabajo del
// host nativo (ffmpeg); byteranges en playlists live son raros y no se
// re-resuelven entre ventanas.

(function (global) {
  "use strict";

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
    let v = BigInt(Math.max(0, Math.floor(Number(seq))));
    for (let i = 15; i >= 8; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  // --- Parser de master playlist (#EXT-X-STREAM-INF) ---
  // Devuelve { variants: [{bandwidth, resolution, codecs, url}] } o null si no
  // es un master. Los variant-playlists anidados se resuelven en downloadHls.
  function parseMaster(text, baseUrl) {
    if (!text.includes("#EXT-X-STREAM-INF")) return null;
    const variants = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const attrs = line.slice("#EXT-X-STREAM-INF:".length);
      const attr = (name) => {
        const m = attrs.match(new RegExp(`${name}=([^,]+)`, "i"));
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
      variants.push({
        bandwidth,
        resolution: attr("RESOLUTION"),
        codecs: attr("CODECS"),
        url: resolveUrl(uri, baseUrl),
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
    // Offset acumulativo por recurso: cuando BYTERANGE omite el offset, empieza
    // donde acabó el anterior para la MISMA URI (RFC 8216 §4.3.2.2).
    const nextOffsetByUrl = new Map();

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
        const attr = (name) => {
          const m = attrs.match(new RegExp(`${name}=([^,]+)`, "i"));
          return m ? m[1].replace(/^"|"$/g, "") : "";
        };
        const method = attr("METHOD");
        if (method === "NONE") {
          currentKey = null;
        } else if (method === "AES-128") {
          const iv = parseHexIv(attr("IV"));
          currentKey = { method, uri: resolveUrl(attr("URI"), baseUrl), iv };
        } else if (method === "SAMPLE-AES" || method === "SAMPLE-AES-CTR") {
          throw new Error(
            "El stream usa SAMPLE-AES (DRM del reproductor): no es descifrable sin el host nativo/yt-dlp."
          );
        }
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = line.slice(11);
        const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1] || "";
        if (!uri) continue;
        let mapByterange = null;
        const br = attrs.match(/BYTERANGE="(\d+)@?(\d+)?"/i);
        if (br) {
          mapByterange = { length: Number(br[1]), offset: br[2] !== undefined ? Number(br[2]) : null };
        }
        currentMap = { url: resolveUrl(uri, baseUrl), byterange: mapByterange };
        continue;
      }
      if (line.startsWith("#")) continue; // cualquier otro tag: ignorar
      // Línea de recurso: el segmento pendiente.
      const segUrl = resolveUrl(line, baseUrl);
      let byterange = null;
      if (pendingByterange) {
        let offset = pendingByterange.offset;
        if (offset === null || offset === undefined) {
          offset = nextOffsetByUrl.get(segUrl) || 0;
        }
        nextOffsetByUrl.set(segUrl, offset + pendingByterange.length);
        byterange = { length: pendingByterange.length, offset };
        pendingByterange = null;
      }
      segments.push({
        url: segUrl,
        seq: mediaSequence + segments.length,
        duration: pendingDuration,
        byterange,
        key: currentKey ? { method: currentKey.method, uri: currentKey.uri, iv: currentKey.iv } : null,
        map: currentMap ? { url: currentMap.url, byterange: currentMap.byterange } : null,
      });
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
    };
  }

  // --- Descifrado AES-128 (WebCrypto) ---

  const keyCache = new Map(); // uri -> Uint8Array(16)

  async function fetchKey(key, fetchImpl) {
    if (keyCache.has(key.uri)) return keyCache.get(key.uri);
    const res = await fetchImpl(key.uri, { credentials: "include", cache: "no-store" });
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
      let chosen;
      if (quality === "best") {
        chosen = master.variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
      } else {
        chosen = master.variants.find((v) => String(v.bandwidth) === String(quality)) || master.variants[0];
      }
      variant = chosen;
      playlistUrl = chosen.url;
    }
    return { playlistUrl, text, variant };
  }

  // Fábrica del fetcher de recursos (segmentos/init) con Range para
  // BYTERANGE, reintentos con backoff y abort cooperativo.
  function createFetchResource({ doFetch, retries = 2, isAborted }) {
    return async (segUrl, byterange) => {
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

  // Descarga y descifra un segmento aplicando su EXT-X-MAP (init deduplicado
  // en mapBuffers) y su KEY AES-128 (IV explícito o media sequence absoluta).
  async function processSegment(seg, fetchResource, doFetch, mapBuffers) {
    let buf = await fetchResource(seg.url, seg.byterange);
    if (seg.key) {
      const keyBytes = await fetchKey(seg.key, doFetch);
      const iv = seg.key.iv || sequenceIv(seg.seq);
      buf = await decryptAes128(keyBytes, iv, buf);
    }
    if (seg.map && !mapBuffers.has(seg.map.url)) {
      // El init segment del MAP activo se descarga con su BYTERANGE propio
      // (el parser ya resolvió offset acumulativo y longitud).
      mapBuffers.set(seg.map.url, await fetchResource(seg.map.url, seg.map.byterange));
    }
    return buf;
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
    } = opts || {};

    const doFetch = async (u, o = {}) => {
      if (beforeFetch) await beforeFetch(u);
      return fetchImpl(u, { credentials: "include", cache: "force-cache", ...o });
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

    const fetchResource = createFetchResource({ doFetch, retries, isAborted: aborted });
    const total = media.segments.length;
    const buffers = new Array(total);
    const mapBuffers = new Map(); // mapUrl -> Uint8Array
    let done = 0;
    let bytes = 0;
    let firstBytes = null; // para detectar el contenedor por magic bytes

    const runSegment = async (seg, index) => {
      const buf = await processSegment(seg, fetchResource, doFetch, mapBuffers);
      buffers[index] = buf;
      if (!firstBytes && buf.length >= 4) firstBytes = buf.slice(0, 12);
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

    // Concatenación binaria en orden de reproducción.
    const parts = [];
    if (kind === "fmp4") {
      for (const mapBuf of mapBuffers.values()) parts.push(mapBuf);
    }
    for (const b of buffers) parts.push(b);
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
      return fetchImpl(u, { credentials: "include", cache: "force-cache", ...o });
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
    if (!initialMedia) {
      const resolved = await resolveVariantPlaylist({ url, quality, doFetch, throwIfAborted });
      playlistUrl = resolved.playlistUrl;
      variant = resolved.variant;
    }

    // 2) Estado del live: dedupe por media sequence absoluta.
    const seen = new Set(); // seq ya encolados
    const buffers = new Map(); // seq -> Uint8Array
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

    // Semilla: la ventana actual ya parseada por downloadHls entra primero.
    if (initialMedia) {
      for (const seg of initialMedia.segments) {
        if (seen.has(seg.seq)) continue;
        seen.add(seg.seq);
        durationSeen += seg.duration || 0;
        pending.push(seg);
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
      const buf = await processSegment(seg, fetchResource, doFetch, mapBuffers);
      buffers.set(seg.seq, buf);
      if (!firstBytes && buf.length >= 4) firstBytes = buf.slice(0, 12);
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

    // 5) Ensamblado en orden de reproducción (por seq absoluta).
    const ordered = [...buffers.keys()].sort((a, b) => a - b).map((k) => buffers.get(k));
    // Los lives fMP4 declaran EXT-X-MAP (init deduplicado en mapBuffers);
    // sin MAP se aplica el sniffing de magic bytes sobre el primer segmento.
    const finalKind = mapBuffers.size > 0 ? "fmp4" : sniffContainer(false, firstBytes);

    const parts = [];
    if (finalKind === "fmp4") {
      for (const mapBuf of mapBuffers.values()) parts.push(mapBuf);
    }
    for (const b of ordered) parts.push(b);
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

  // Limpieza de la caché de claves (los tokens AES expiran entre descargas).
  function clearKeyCache() {
    keyCache.clear();
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
