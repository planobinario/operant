// debug-panel.js — DEPURACIÓN TEMPORAL: inspección DOM real de las cards.
// Vuelca el outerHTML de las primeras cards, estilos computados del thumb/img,
// estado de carga de las imágenes (naturalWidth) y errores de consola.
// Uso: node tests/debug-panel.js

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start: startFixtures } = require("./fixtures-server");

const EXT_SRC = path.resolve(__dirname, "..", "src");
const CFT_CACHE = path.join(__dirname, ".chrome");
const FIXTURE = "http://localhost:8765";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findExe() {
  for (const plat of fs.readdirSync(path.join(CFT_CACHE, "chrome"))) {
    for (const v of fs.readdirSync(path.join(CFT_CACHE, "chrome", plat))) {
      const exe = path.join(CFT_CACHE, "chrome", plat, v, "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

(async () => {
  startFixtures(8765);
  const browser = await puppeteer.launch({
    executablePath: await findExe(),
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operant-debug-")),
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
    args: [
      `--load-extension=${EXT_SRC}`,
      `--disable-extensions-except=${EXT_SRC}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  let sw = null;
  for (let i = 0; i < 40; i++) {
    sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
    if (sw) break;
    await sleep(500);
  }
  const extId = /chrome-extension:\/\/([^/]+)\//.exec(sw.url())[1];
  console.log("Extension:", extId);

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push("PAGE: " + m.text().slice(0, 200)); });
  await page.goto(FIXTURE + "/gallery.html", { waitUntil: "domcontentloaded" });
  await sleep(1200);

  const panel = await browser.newPage();
  const panelErrors = [];
  panel.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") panelErrors.push(`PANEL ${m.type()}: ` + m.text().slice(0, 300));
  });
  panel.on("pageerror", (e) => panelErrors.push("PANEL pageerror: " + String(e).slice(0, 300)));
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await sleep(4000);
  await panel.evaluate(`window.__operant.pin = true`);
  await panel.bringToFront();
  await sleep(2500);

  const dump = await panel.evaluate(`(() => {
    const cards = [...document.querySelectorAll('#grid .card:not(.skeleton)')];
    const first = cards[0];
    if (!first) return { cards: 0 };
    const thumb = first.querySelector('.card-thumb');
    const img = first.querySelector('.card-thumb img');
    const cs = (el) => { const s = getComputedStyle(el); return { display: s.display, width: s.width, height: s.height, opacity: s.opacity, objectFit: s.objectFit, visibility: s.visibility }; };
    return {
      cards: cards.length,
      html: first.outerHTML.slice(0, 900),
      thumbStyle: thumb ? (thumb.getAttribute('style') || '(none)') : null,
      thumbCS: thumb ? cs(thumb) : null,
      imgExists: !!img,
      imgSrc: img ? img.getAttribute('src') : null,
      imgCS: img ? cs(img) : null,
      imgReady: img ? { nw: img.naturalWidth, nh: img.naturalHeight, complete: img.complete } : null,
      firstNames: cards.slice(0, 5).map(c => c.querySelector('.card-name')?.textContent),
    };
  })()`);
  console.log("=== DUMP DOM ===");
  console.log(JSON.stringify(dump, null, 2));

  console.log("=== CONSOLA ===");
  console.log(panelErrors.join("\n") || "(sin errores de consola en el panel)");
  console.log(pageErrors.join("\n") || "(sin errores de consola en la página)");

  // PROBE: ¿qué anula la altura inline de 120px?
  const probe = await panel.evaluate(`(() => {
    const t = document.querySelector('.card-thumb');
    const img = t.querySelector('img');
    const out = {};
    // 1. Sin aspect-ratio en el thumb
    t.style.aspectRatio = 'auto';
    out.arOff = getComputedStyle(t).height;
    t.style.aspectRatio = '';
    out.arBack = getComputedStyle(t).height;
    // 2. Con min-height forzado
    t.style.minHeight = '120px';
    out.minH = getComputedStyle(t).height;
    t.style.minHeight = '';
    // 3. Con height auto (regla CSS pura)
    t.style.height = '';
    out.cssOnly = getComputedStyle(t).height;
    t.style.height = '120px';
    out.inlineBack = getComputedStyle(t).height;
    // 4. El body del card (flex:1) ¿es el que aplasta?
    const card = t.closest('.card');
    const body = card.querySelector('.card-body');
    body.style.flex = '0 0 auto';
    t.style.aspectRatio = '';
    out.bodyFlexOff = getComputedStyle(t).height;
    body.style.flex = '';
    // 5. Card como grid item: probar align-self
    card.style.alignSelf = 'start';
    out.alignSelf = getComputedStyle(t).height;
    card.style.alignSelf = '';
    // 6. min-height:0 en el grid row? probar grid-auto-rows
    const g = document.getElementById('grid');
    g.style.gridAutoRows = 'auto';
    out.gridAutoRows = getComputedStyle(t).height;
    g.style.gridAutoRows = '';
    return out;
  })()`);
  console.log("=== PROBE ===");
  console.log(JSON.stringify(probe, null, 2));

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("Fallo:", e);
  process.exit(1);
});
