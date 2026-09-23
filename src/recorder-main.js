// recorder-main.js — Modo grabación: hook de MediaSource en el mundo MAIN.
// Se inyecta en document_start (antes de cualquier script de la página) y
// envuelve addSourceBuffer para capturar una copia de cada appendBuffer.
//
// Diseño:
//   - Los init segments (ftyp/styp/moov, o el primer buffer de cada
//     SourceBuffer) se capturan SIEMPRE: son pequeños y permiten empezar a
//     grabar con el vídeo ya en marcha sin perder el init.
//   - Los media segments solo se capturan mientras capturing === true.
//   - Las pistas se agrupan por MediaSource (un reproductor típico crea uno
//     con vídeo + audio): el host nativo las unirá con ffmpeg.
//   - Al parar, cada pista se entrega en trozos base64 de 600 KB (bajo el
//     límite de 1 MB por mensaje del host nativo) vía window.postMessage,
//     que cruza los mundos MAIN ↔ ISOLATED.
//
// Limitación documentada: EME/DRM no es capturable (los buffers llegan
// cifrados desde el CDM). Solo MSE de contenido claro.

(function () {
  "use strict";

  // Si chrome.runtime.id existe somos el mundo ISOLATED (fallback en Gecko
  // < 128, que ignora "world"): no hacer nada en ese caso.
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) return;
  if (window.__operantRecorderInstalled) return;
  window.__operantRecorderInstalled = true;

  const CHUNK_RAW = 600 * 1024; // bytes por chunk base64 (< 1 MB del host)

  const state = {
    capturing: false,
    nextId: 1,
    sources: new Map(), // msId -> { id, tracks: Map<track, {init, segments, bytes, mimeType}> }
    statsTimer: null,
  };

  function trackKind(mimeType) {
    return /^audio\//i.test(mimeType || "") ? "audio" : "video";
  }

  // fMP4: ftyp/styp/moov en los bytes 4-7 del box inicial.
  function isInitSegment(u8) {
    if (u8.length < 8) return false;
    const brand = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    return brand === "ftyp" || brand === "styp" || brand === "moov";
  }

  function getOrCreateSource(ms) {
    for (const src of state.sources.values()) {
      if (src.ms === ms) return src;
    }
    const src = { id: state.nextId++, ms, tracks: new Map(), bytes: 0 };
    state.sources.set(src.id, src);
    return src;
  }

  function getOrCreateTrack(src, mimeType) {
    const kind = trackKind(mimeType);
    if (!src.tracks.has(kind)) {
      src.tracks.set(kind, { kind, mimeType: mimeType || "", init: null, segments: [], bytes: 0 });
    }
    return src.tracks.get(kind);
  }

  function captureBuffer(track, u8) {
    const isInit = isInitSegment(u8) || (track.init === null && track.segments.length === 0);
    if (isInit) {
      track.init = u8; // el init más reciente es el vigente
      return;
    }
    if (!state.capturing) return;
    track.segments.push(u8);
    track.bytes += u8.byteLength;
  }

  // --- Hook de MediaSource.addSourceBuffer (idempotente) ---

  if (typeof MediaSource === "undefined" || !MediaSource.prototype.addSourceBuffer) return;
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    try {
      const src = getOrCreateSource(this);
      const track = getOrCreateTrack(src, mimeType);
      const origAppend = sb.appendBuffer;
      sb.appendBuffer = function (data) {
        try {
          if (data && data.byteLength) {
            const copy = new Uint8Array(data.byteLength);
            copy.set(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength));
            captureBuffer(track, copy);
          }
        } catch {
          /* la captura nunca debe romper al reproductor */
        }
        return origAppend.call(this, data);
      };
    } catch {
      /* idem */
    }
    return sb;
  };

  // --- Protocolo de mensajes con el content script (mismo window) ---

  function send(msg) {
    msg.__operantRec = true;
    window.postMessage(msg, window.location.origin);
  }

  function stats() {
    let bytes = 0;
    let segments = 0;
    let sources = 0;
    for (const src of state.sources.values()) {
      let srcBytes = 0;
      for (const t of src.tracks.values()) {
        srcBytes += t.init ? t.init.byteLength : 0;
        srcBytes += t.bytes;
        segments += t.segments.length;
      }
      if (srcBytes > 0) sources++;
      bytes += srcBytes;
    }
    return { bytes, segments, sources };
  }

  function largestSource() {
    let best = null;
    let bestBytes = 0;
    for (const src of state.sources.values()) {
      let total = 0;
      let nonEmpty = 0;
      for (const t of src.tracks.values()) {
        total += t.bytes;
        if (t.segments.length > 0) nonEmpty++;
      }
      if (total > bestBytes && nonEmpty > 0) {
        bestBytes = total;
        best = src;
      }
    }
    return best;
  }

  function u8ToB64(u8) {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  async function stopAndDeliver() {
    state.capturing = false;
    if (state.statsTimer) {
      clearInterval(state.statsTimer);
      state.statsTimer = null;
    }
    const src = largestSource();
    if (!src) {
      send({ type: "stopped", error: "No se ha capturado ningún buffer MSE." });
      return;
    }
    // Entrega pista a pista: init primero, luego segmentos troceados.
    const tracks = [...src.tracks.values()].filter((t) => t.segments.length > 0 || (t.init && t.init.byteLength));
    for (const t of tracks) {
      const pieces = [];
      if (t.init && t.init.byteLength) pieces.push(t.init);
      pieces.push(...t.segments);
      const totalChunks = Math.ceil(
        pieces.reduce((n, p) => n + p.byteLength, 0) / CHUNK_RAW
      );
      send({ type: "track-begin", track: t.kind, mimeType: t.mimeType, chunks: totalChunks, bytes: t.bytes });
      let i = 0;
      for (const piece of pieces) {
        for (let off = 0; off < piece.byteLength; off += CHUNK_RAW) {
          const slice = piece.subarray(off, Math.min(piece.byteLength, off + CHUNK_RAW));
          i++;
          send({ type: "track-chunk", track: t.kind, index: i, of: totalChunks, data: u8ToB64(slice) });
          // Ceder el bucle entre chunks para no bloquear el hilo del reproductor.
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      send({ type: "track-end", track: t.kind, chunks: i });
    }
    send({
      type: "stopped",
      bytes: [...src.tracks.values()].reduce((n, t) => n + t.bytes, 0),
      tracks: tracks.length,
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !msg.__operantRecCmd) return;
    try {
      if (msg.cmd === "start") {
        if (state.capturing) {
          send({ type: "started", already: true });
          return;
        }
        state.capturing = true;
        // El init de cada SourceBuffer ya se captura siempre (es pequeño), así
        // que empezar a grabar con el vídeo en marcha no lo pierde.
        state.statsTimer = setInterval(() => send({ type: "stats", ...stats() }), 2000);
        send({ type: "started", sources: stats().sources });
      } else if (msg.cmd === "stop") {
        stopAndDeliver();
      } else if (msg.cmd === "cancel") {
        state.capturing = false;
        if (state.statsTimer) {
          clearInterval(state.statsTimer);
          state.statsTimer = null;
        }
        for (const src of state.sources.values()) {
          for (const t of src.tracks.values()) {
            t.segments = [];
            t.bytes = 0;
          }
        }
        send({ type: "cancelled" });
      } else if (msg.cmd === "ping") {
        send({ type: "pong", capturing: state.capturing, ...stats() });
      }
    } catch (e) {
      send({ type: "stopped", error: String(e?.message || e) });
    }
  });
})();
