// generate-fixtures.js — Genera las páginas de prueba locales para la verificación.
// Uso: node tests/generate-fixtures.js   (escribe en tests/fixtures/)

const fs = require("fs");
const path = require("path");

const FIX = path.join(__dirname, "fixtures");
const PAGES = path.join(FIX, "pages");
const CSS = path.join(FIX, "css");
const MEDIA = path.join(FIX, "media");

fs.mkdirSync(PAGES, { recursive: true });
fs.mkdirSync(CSS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const img = (w, h, label) => `/img/${w}x${h}?g=${label}`;
const html = (title, body) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

// ---------- gallery.html: lazy-load, srcset, picture, background CSS, duplicados ----------
{
  let b = `<link rel="stylesheet" href="/css/bg.css"><h1>Galeria de prueba</h1>`;
  for (let i = 0; i < 60; i++) b += `<img src="${img(200, 120, `plain${i}`)}" alt="p${i}">`;
  for (let i = 0; i < 50; i++) b += `<img data-src="${img(200, 120, `lazy${i}`)}" data-lazy-src="${img(200, 120, `lazy2_${i}`)}" alt="l${i}">`;
  for (let i = 0; i < 30; i++) b += `<img srcset="${img(300, 180, `ss${i}a`)} 1x, ${img(600, 360, `ss${i}b`)} 2x" alt="s${i}">`;
  for (let i = 0; i < 20; i++) b += `<picture><source srcset="${img(400, 240, `pc${i}a`)} 400w, ${img(800, 480, `pc${i}b`)} 800w" sizes="100vw"><img src="${img(400, 240, `pc${i}`)}" alt="p${i}"></picture>`;
  for (let i = 0; i < 30; i++) b += `<div style="background-image:url('${img(250, 150, `bg${i}`)}')"></div>`;
  for (let i = 0; i < 10; i++) b += `<div class="bgcss bgcss${i}"></div>`;
  // 5 duplicados con fragmento (deben deduplicarse) + 5 con query distinta (recursos distintos)
  for (let i = 0; i < 5; i++) b += `<img src="${img(200, 120, "plain0")}#frag${i}" alt="dup${i}">`;
  for (let i = 0; i < 5; i++) b += `<img src="${img(200, 120, "plain0")}?x=${i}" alt="dupq${i}">`;
  // 3 data: URIs (deben EXCLUIRSE)
  for (let i = 0; i < 3; i++) b += `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="data${i}">`;
  fs.writeFileSync(path.join(PAGES, "gallery.html"), html("gallery", b));
}

// ---------- big.html: rendimiento (600 imágenes) ----------
{
  let b = `<h1>Big</h1>`;
  for (let i = 0; i < 400; i++) b += `<img src="${img(200, 120, `big${i}`)}" alt="b${i}">`;
  for (let i = 0; i < 200; i++) b += `<img data-src="${img(200, 120, `biglazy${i}`)}" alt="bl${i}">`;
  for (let i = 0; i < 10; i++) b += `<img src="${img(200, 120, "big0")}#d${i}" alt="dup${i}">`;
  fs.writeFileSync(path.join(PAGES, "big.html"), html("big", b));
}

// ---------- video.html: HTML5 nativo ----------
{
  const b = `
    <h1>Video nativo</h1>
    <video controls preload="metadata" poster="${img(640, 360, "poster1")}">
      <source src="/media/sample.mp4" type="video/mp4">
      <source src="/media/sample.webm" type="video/webm">
    </video>
    <audio controls preload="metadata"><source src="/media/tone.mp3" type="audio/mpeg"></audio>
    <video src="/media/sample.mp4" controls muted></video>`;
  fs.writeFileSync(path.join(PAGES, "video.html"), html("video", b));
}

// ---------- xlike.html: reproductor "hostil" estilo X/Twitter ----------
// Simula la estructura del HTML real de X: múltiples capas con transform
// (stacking contexts), el <video> con src blob: (MSE) y una capa de controles
// encima que captura los eventos de puntero. El overlay debe aparecer igual.
{
  const b = `
    <h1>Reproductor estilo X/Twitter</h1>
    <div style="transform: translateZ(0px); position: relative; width: 560px; height: 315px;">
      <div style="transform: translateZ(0px); position: relative; width: 100%; height: 100%;">
        <div data-testid="videoPlayer" style="position: relative; width: 100%; height: 100%; background: #000;">
          <video src="blob:https://x.com/26b38812-aaaa-4bbb-9ccc-1234567890ab" muted playsinline
            style="width: 100%; height: 100%; object-fit: contain;"></video>
          <!-- Capa de controles de X encima del video: captura pointer events -->
          <div data-testid="videoPlayerControls" style="position: absolute; inset: 0; z-index: 10;">
            <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(transparent, rgba(0,0,0,0.7));">
              <button style="position: absolute; left: 8px; top: 8px;">Play</button>
              <button style="position: absolute; right: 48px; top: 8px;">Mute</button>
              <button style="position: absolute; right: 8px; top: 8px;">Fullscreen</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p>El overlay debe aparecer al pasar el ratón, aunque la capa de controles capture el mouseover.</p>`;
  fs.writeFileSync(path.join(PAGES, "xlike.html"), html("xlike", b));
}

// ---------- embeds.html: iframes de embeds conocidos ----------
{
  const b = `
    <h1>Embeds</h1>
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>
    <iframe src="https://youtu.be/dQw4w9WgXcQ" width="560" height="315"></iframe>
    <iframe src="https://player.vimeo.com/video/76979871" width="560" height="315"></iframe>
    <iframe src="https://www.dailymotion.com/embed/video/x8v4o0e" width="560" height="315"></iframe>
    <iframe src="https://twitter.com/i/videos/tweet/1" width="560" height="315"></iframe>`;
  fs.writeFileSync(path.join(PAGES, "embeds.html"), html("embeds", b));
}

// ---------- files.html: archivos descargables ----------
{
  const b = `
    <h1>Archivos</h1>
    <a href="/downloads/sample.pdf">PDF</a>
    <a href="/downloads/sample.zip">ZIP</a>
    <a href="/downloads/report.docx">DOCX</a>
    <a href="/downloads/archive.tar.gz">TGZ</a>
    <a href="/media/sample.mp4">MP4 directo</a>
    <a href="/media/tone.mp3">MP3 directo</a>
    <a href="#section">ancla (no es archivo)</a>
    <a href="mailto:test@example.com">mailto (no es archivo)</a>
    <a href="javascript:void(0)">js (no es archivo)</a>
    <a href="https://example.com/page">pagina normal (no es archivo)</a>`;
  fs.writeFileSync(path.join(PAGES, "files.html"), html("files", b));
}

// ---------- spa.html: contenido dinámico (scroll + cambio de ruta) ----------
{
  const b = `
    <h1>SPA de prueba</h1>
    <div id="feed"></div>
    <button id="route">cambiar ruta</button>
    <script>
      const feed = document.getElementById("feed");
      let n = 0;
      function inject(k) {
        for (let i = 0; i < 15; i++) {
          const d = document.createElement("div");
          d.innerHTML = '<img data-src="${img(200, 120, "spa")}' + k + '_' + (n++) + '" alt="s">';
          feed.appendChild(d.firstChild);
        }
      }
      for (let i = 0; i < 4; i++) inject("init");
      window.addEventListener("scroll", () => {
        if (innerHeight + scrollY >= document.body.scrollHeight - 300) inject("scroll");
      });
      document.getElementById("route").addEventListener("click", () => {
        feed.replaceChildren();
        inject("route");
        const v = document.createElement("video");
        v.src = "/media/sample.mp4";
        document.body.appendChild(v);
      });
    </script>`;
  fs.writeFileSync(path.join(PAGES, "spa.html"), html("spa", b));
}

// ---------- shadow.html: Shadow DOM abierto y cerrado ----------
{
  const b = `
    <h1>Shadow DOM</h1>
    <custom-widget id="open"></custom-widget>
    <closed-widget id="closed"></closed-widget>
    <div style="background-image:url('${img(250, 150, "shadowbg")}')"></div>
    <script>
      class OpenWidget extends HTMLElement {
        constructor() {
          super();
          const r = this.attachShadow({ mode: "open" });
          r.innerHTML = '<img src="${img(200, 120, "shadow1")}"><img data-src="${img(200, 120, "shadow2")}"><video src="/media/sample.mp4"></video>';
        }
      }
      class ClosedWidget extends HTMLElement {
        constructor() {
          super();
          const r = this.attachShadow({ mode: "closed" });
          r.innerHTML = '<img src="${img(200, 120, "closed1")}">';
        }
      }
      customElements.define("custom-widget", OpenWidget);
      customElements.define("closed-widget", ClosedWidget);
    </script>`;
  fs.writeFileSync(path.join(PAGES, "shadow.html"), html("shadow", b));
}

// ---------- hls.html: HLS con hls.js ----------
{
  const b = `
    <h1>HLS (hls.js)</h1>
    <video id="v" muted autoplay controls></video>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script>
      if (Hls.isSupported()) {
        const h = new Hls();
        h.loadSource("/media/stream.m3u8");
        h.attachMedia(document.getElementById("v"));
        h.on(Hls.Events.MANIFEST_PARSED, () => document.getElementById("v").play().catch(() => {}));
      }
    </script>`;
  fs.writeFileSync(path.join(PAGES, "hls.html"), html("hls", b));
}

// ---------- dash.html: DASH con dash.js ----------
{
  const b = `
    <h1>DASH (dash.js)</h1>
    <video id="v" muted autoplay controls></video>
    <script src="https://cdn.dashjs.org/latest/dash.all.min.js"></script>
    <script>
      const p = dashjs.MediaPlayer().create();
      p.initialize(document.getElementById("v"), "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd", true);
    </script>`;
  fs.writeFileSync(path.join(PAGES, "dash.html"), html("dash", b));
}

// ---------- css/bg.css ----------
{
  let css = `.bgcss { width: 12px; height: 12px; }\n`;
  for (let i = 0; i < 10; i++) css += `.bgcss${i} { background-image: url('${img(250, 150, `cssbg${i}`)}'); }\n`;
  fs.writeFileSync(path.join(CSS, "bg.css"), css);
}

// ---------- Archivos de descarga ----------
{
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\ntrailer<</Root 1 0 R>>\n%%EOF\n"
  );
  const zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(10), Buffer.from("PK\x05\x06"), Buffer.alloc(18)]);
  fs.writeFileSync(path.join(MEDIA, "sample.pdf"), pdf);
  fs.writeFileSync(path.join(MEDIA, "sample.zip"), zip);
  fs.writeFileSync(path.join(MEDIA, "report.docx"), Buffer.from("fake docx for extension detection"));
  fs.writeFileSync(path.join(MEDIA, "archive.tar.gz"), Buffer.from("fake tgz for extension detection"));

  fs.mkdirSync(path.join(FIX, "downloads"), { recursive: true });
  fs.writeFileSync(path.join(FIX, "downloads", "sample.pdf"), pdf);
  fs.writeFileSync(path.join(FIX, "downloads", "sample.zip"), zip);
  fs.writeFileSync(path.join(FIX, "downloads", "report.docx"), Buffer.from("fake docx"));
  fs.writeFileSync(path.join(FIX, "downloads", "archive.tar.gz"), Buffer.from("fake tgz"));
}

console.log("fixtures generados en", FIX);
