// fixtures-server.js — Servidor HTTP local para los fixtures de prueba.
// Sirve páginas, CSS, media (mp4/webm/mp3/m3u8/ts) y genera PNGs al vuelo.
// Uso: node tests/fixtures-server.js [puerto]   (por defecto 8765)

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "fixtures");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// --- Generador de "fotos": PNGs RGB con gradiente determinista por semilla.
// Da contenido visual real (no iconos) para las capturas de evidencia del
// panel, con ratios variados (1200x800, 900x1200, 1600x600, 800x800...).
const gradientCache = new Map();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function gradientPng(w, h, seed) {
  const key = `${w}x${h}x${seed}`;
  if (gradientCache.has(key)) return gradientCache.get(key);
  const rowSize = 1 + w * 3;
  const raw = Buffer.alloc(rowSize * h);
  const p = (x, y) => {
    const t = (x / w + y / h + seed * 0.37) % 1;
    return [
      Math.round(96 + 140 * Math.sin(t * 6.283)),
      Math.round(96 + 120 * Math.sin(t * 6.283 + 2.1)),
      Math.round(110 + 120 * Math.sin(t * 6.283 + 4.2)),
    ];
  };
  for (let y = 0; y < h; y++) {
    const off = y * rowSize;
    raw[off] = 0; // filtro "none"
    for (let x = 0; x < w; x++) {
      const [r, g, b] = p(x, y);
      const o = off + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  gradientCache.set(key, png);
  return png;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gz": "application/gzip",
  ".png": "image/png",
};

// Blob grande para probar descargas con Range: 12 MB de bytes repetidos.
const RANGED_BLOB = Buffer.alloc(12 * 1024 * 1024, 0x61);

// Endpoint generador de archivos grandes al vuelo (sin reservar RAM en el
// servidor): /big/<MB>.bin devuelve un stream de bytes repetidos con
// Content-Length y Accept-Ranges reales. Usado para probar el límite de
// tamaño del mecanismo blob->panel con vídeos de cientos de MB.
function bigStream(mb) {
  const total = mb * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 0x62); // 'b'
  let sent = 0;
  return {
    total,
    pipe(res) {
      const step = () => {
        while (sent < total) {
          const n = Math.min(chunk.length, total - sent);
          res.write(chunk.subarray(0, n));
          sent += n;
          if (res.writableLength > 4 * 1024 * 1024) {
            res.once("drain", step);
            return;
          }
        }
        res.end();
      };
      step();
    },
  };
}

function start(port = 8765) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    // Fotos con gradiente real (evidencia visual): /img/g/<ancho>/<alto>/<semilla>
    const g = /^\/img\/g\/(\d{2,4})\/(\d{2,4})\/(\d+)$/.exec(p);
    if (g) {
      const w = Math.min(2400, Number(g[1]));
      const h = Math.min(2400, Number(g[2]));
      const png = gradientPng(w, h, Number(g[3]) || 0);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "no-store",
      });
      res.end(png);
      return;
    }

    if (p.startsWith("/img/")) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": TINY_PNG.length,
        "Cache-Control": "no-store",
      });
      res.end(TINY_PNG);
      return;
    }

    // Imagen "problemática": HEAD sin Content-Length y GET sin Content-Range
    // (simula servidores tipo gstatic que rompen el enriquecimiento de tamaño).
    if (p === "/img-nolen.png") {
      const body = TINY_PNG;
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }

    // Vídeo REAL servido con una URL que NO termina en .mp4 (termina en .htm) —
    // el caso exacto del usuario: el servidor devuelve video/mp4 aunque la URL
    // parezca una página. Reproduce el bug de la decisión por extensión.
    if (p === "/video-stream.htm") {
      const file = path.join(ROOT, "media", "sample.mp4");
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    // Vídeo "protegido" (simula anti-hotlink): exige un Referer de la misma página.
    // El SW/descarga directa no envía Referer -> 403. El fetch en-página sí lo
    // envía automáticamente -> 200. Reproduce el anti-hotlink real.
    if (p === "/video-protected.mp4") {
      const file = path.join(ROOT, "media", "sample.mp4");
      const ref = req.headers.referer || "";
      if (!ref.startsWith("http://localhost:8765")) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html>bloqueado: falta referer</html>");
        return;
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
      res.end(body);
      return;
    }

    // ARCHIVO GRANDE PROTEGIDO (simula vídeo pesado en CDN con anti-hotlink por Referer):
    // exige Referer local Y soporta Range (206). Combina los dos casos: /protected-big/<MB>.bin.
    const pbig = /^\/protected-big\/(\d+)\.bin$/.exec(p);
    if (pbig) {
      const s = bigStream(Math.min(2000, Number(pbig[1])));
      const ref = req.headers.referer || "";
      if (!ref.startsWith("http://localhost:8765")) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html>bloqueado: falta referer</html>");
        return;
      }
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : s.total - 1;
          const len = Math.min(end + 1, s.total) - start;
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${start + len - 1}/${s.total}`,
            "Content-Length": len,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          });
          const chunk = Buffer.alloc(64 * 1024, 0x62);
          let sent = 0;
          const step = () => {
            while (sent < len) {
              const n = Math.min(chunk.length, len - sent);
              res.write(chunk.subarray(0, n));
              sent += n;
              if (res.writableLength > 4 * 1024 * 1024) {
                res.once("drain", step);
                return;
              }
            }
            res.end();
          };
          step();
          return;
        }
      }
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": s.total,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": s.total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      s.pipe(res);
      return;
    }

    // Vídeo "protegido" CROSS-ORIGIN (simula CDN estricta sin cabeceras CORS):
    // exige Referer y responde SIN Access-Control-Allow-Origin.
    // El fetch DESDE la página muere por CORS (el bug real) aunque el recurso
    // exista; solo un fetch del SW (sin CORS) con el Referer inyectado por DNR
    // lo puede leer.
    if (p === "/video-protected-xo.mp4") {
      const file = path.join(ROOT, "media", "sample.mp4");
      const ref = req.headers.referer || "";
      if (!/^https?:\/\/localhost:\d+/.test(ref)) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html>bloqueado: falta referer</html>");
        return;
      }
      const body = fs.readFileSync(file);
      // Nota: SIN Access-Control-Allow-Origin a propósito (simula CDN cross-origin estricta).
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
      res.end(body);
      return;
    }

    // Archivo grande generado al vuelo (stream, sin reservar RAM): /big/<MB>.bin.
    // Soporta Range (206) para probar la descarga por chunks del panel.
    const big = /^\/big\/(\d+)\.bin$/.exec(p);
    if (big) {
      const s = bigStream(Math.min(2000, Number(big[1])));
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : s.total - 1;
          const len = Math.min(end + 1, s.total) - start;
          res.writeHead(206, {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${start + len - 1}/${s.total}`,
            "Content-Length": len,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          });
          // Emitir solo el rango pedido (los bytes son repetidos 'b').
          const chunk = Buffer.alloc(64 * 1024, 0x62);
          let sent = 0;
          const step = () => {
            while (sent < len) {
              const n = Math.min(chunk.length, len - sent);
              res.write(chunk.subarray(0, n));
              sent += n;
              if (res.writableLength > 4 * 1024 * 1024) {
                res.once("drain", step);
                return;
              }
            }
            res.end();
          };
          step();
          return;
        }
      }
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": s.total,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": s.total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      s.pipe(res);
      return;
    }

    // Endpoint con soporte real de Range (Accept-Ranges + 206) para probar
    // la descarga por chunks de la extension.
    if (p === "/ranged.bin") {
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : RANGED_BLOB.length - 1;
          const chunk = RANGED_BLOB.subarray(start, Math.min(end + 1, RANGED_BLOB.length));
          res.writeHead(206, {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${RANGED_BLOB.length}`,
            "Content-Length": chunk.length,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          });
          res.end(chunk);
          return;
        }
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": RANGED_BLOB.length,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      res.end(RANGED_BLOB);
      return;
    }

    // Resolución de rutas dentro de fixtures/ (sin escape de directorio).
    const candidates = [path.join(ROOT, p), path.join(ROOT, "pages", p)];
    const file = candidates.find(
      (c) => c.startsWith(ROOT) && fs.existsSync(c) && fs.statSync(c).isFile()
    );
    if (file) {
      const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Content-Length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found: " + p);
  });

  server.listen(port, () => console.log(`fixtures server: http://localhost:${port}`));
  return server;
}

if (require.main === module) {
  start(Number(process.argv[2]) || 8765);
}

module.exports = { start };
