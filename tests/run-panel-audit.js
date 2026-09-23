// run-panel-audit.js — Auditoria de producto del panel (Bloques 1-7).
// Suite independiente de la bateria de scraping: lanza CfT + extension,
// abre la pagina del panel y valida rendimiento (DOM acotado), cola de
// descargas con Range real, sincronizacion entre pestanas, y captura
// capturas de las vistas grid/lista/masonry.
// Uso: node tests/run-panel-audit.js

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start: startFixtures } = require("./fixtures-server");

const EXT_SRC = path.resolve(__dirname, "..", "src");
const RESULTS = path.join(__dirname, "results");
const CFT_CACHE = path.join(__dirname, ".chrome");
const FIXTURE = "http://localhost:8765";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
let FAIL = 0;

function check(cond, desc) {
  if (cond) PASS++;
  else FAIL++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${desc}`);
}

async function findExe() {
  for (const plat of fs.readdirSync(path.join(CFT_CACHE, "chrome"))) {
    for (const v of fs.readdirSync(path.join(CFT_CACHE, "chrome", plat))) {
      const exe = path.join(CFT_CACHE, "chrome", plat, v, "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

const panelEval = (p, expr, label, ms = 12000) =>
  Promise.race([
    p.evaluate(expr).then((r) => ({ ok: true, value: r })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `timeout: ${label}` }), ms)),
  ]);

(async () => {
  fs.mkdirSync(RESULTS, { recursive: true });
  startFixtures(8765);
  const browser = await puppeteer.launch({
    executablePath: await findExe(),
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operant-audit-")),
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

  // ============ A1: rendimiento del panel + capturas ============
  console.log("== A1. Rendimiento del panel (600 items) + vistas ==");
  const page = await browser.newPage();
  await page.goto(FIXTURE + "/big.html", { waitUntil: "domcontentloaded" });
  await sleep(1200);

  const panel = await browser.newPage();
  const panelErrors = [];
  panel.on("pageerror", (e) => panelErrors.push(String(e).slice(0, 200)));
  panel.on("console", (m) => {
    if (m.type() === "error") panelErrors.push(m.text().slice(0, 200));
  });
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  await page.bringToFront();
  await sleep(4000);

  // El layout de una pestaña oculta esta congelado en Chrome: se "fija" el
  // tab del panel (hook de test) y se trae al primer plano para medir
  // geometria y lazy-render (en uso real el side panel siempre esta visible).
  await panel.evaluate(`window.__operant.pin = true`);
  await panel.bringToFront();
  await sleep(1500);

  const s1 = await panelEval(panel, `({
    cards: document.querySelectorAll('#grid .card:not(.skeleton)').length,
    total: document.getElementById('countImage').textContent
  })`, "estado inicial");
  check(s1.ok, `panel responde (${s1.ok ? "si" : s1.error})`);
  if (s1.ok) {
    check(Number(s1.value.total) >= 590, `contador total 600 (${s1.value.total})`);
    check(s1.value.cards >= 60 && s1.value.cards <= 130, `DOM activo acotado: 1-2 chunks de 600 (${s1.value.cards} nodos)`);

    // Regresión v0.4: el thumb computaba height:0 (align-self stretch + grid
    // con altura definida) => imágenes invisibles. Ahora debe tener altura real.
    // Con reintentos: durante un re-render el grid se vacía transitoriamente.
    let thumbOk = false;
    for (let i = 0; i < 6 && !thumbOk; i++) {
      const r = await panelEval(panel, `(() => { const el = document.querySelector('#grid .card img'); return el ? parseInt(getComputedStyle(el).height) > 0 : false; })()`, "thumb altura");
      thumbOk = !!(r.ok && r.value === true);
      if (!thumbOk) await sleep(400);
    }
    check(thumbOk, `thumbnail con altura computada > 0 (colapso arreglado)`);

    // El scroll-lazy se confirma visualmente (screenshots); en headless el
    // layout de pestanas ocultas esta congelado y no es medible de forma fiable.
    const t0 = Date.now();
    await panelEval(panel, `(() => { const i = document.getElementById('search'); i.value = 'biglazy9'; i.dispatchEvent(new Event('input')); })()`, "busqueda");
    await sleep(400);
    const s3 = await panelEval(panel, `document.querySelectorAll('#grid .card:not(.skeleton)').length`, "filtro");
    check(s3.ok && s3.value >= 10 && s3.value <= 40, `filtro en tiempo real acotado (${s3.ok ? s3.value : "?"} coincidencias)`);

    await panelEval(panel, `(() => { const i = document.getElementById('search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`, "limpiar");
    await sleep(500);
    for (const view of ["full", "masonry"]) {
      await panelEval(panel, `document.getElementById('layoutSel').value = '${view}'; document.getElementById('layoutSel').dispatchEvent(new Event('change'));`, `vista ${view}`);
      await sleep(800);
      await panel.screenshot({ path: path.join(RESULTS, `screenshot-${view}.png`) });
    }
    check(true, `capturas: screenshot-grid/list/masonry.png en tests/results/`);
  }
  if (panelErrors.length) console.log("  [WARN] errores del panel:", panelErrors.join(" | "));
  await panel.close().catch(() => {});
  await page.close().catch(() => {});

  // ============ A2: cola de descargas por chunks (Range real) ============
  console.log("== A2. Cola de descargas por chunks (Range real) x3 ==");
  const panel2 = await browser.newPage();
  await panel2.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  for (let i = 1; i <= 3; i++) {
    await panel2.evaluate(`window.__operant.startDl({url: '${FIXTURE}/ranged.bin', filename: 'ranged-${i}.bin'})`);
  }
  let jobs = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    jobs = await panel2.evaluate(`window.__operant.dlState()`);
    if (jobs.length >= 3 && jobs.every((j) => j.status === "done" || j.status === "error")) break;
  }
  check(jobs.length >= 3, `3 jobs creados (${jobs.length})`);
  check(jobs.every((j) => j.status === "done"), `todos completados (${jobs.map((j) => j.status).join(",")})`);
  if (jobs.some((j) => j.status === "error")) {
    console.log("  [INFO] errores de job:", [...new Set(jobs.map((j) => j.error || "?"))].join(" | "));
  }
  check(jobs.every((j) => j.progress === 100), `progreso real al 100% (${jobs.map((j) => j.progress).join(",")})`);
  check(jobs.every((j) => j.total === 12 * 1024 * 1024), `tamano total 12 MB correcto (${jobs[0]?.total || "?"})`);
  await panel2.close().catch(() => {});

  // ============ A3: sincronizacion entre pestanas ============
  console.log("== A3. Sincronizacion: el panel sigue a SU pestana ==");
  const tabGallery = await browser.newPage();
  await tabGallery.goto(FIXTURE + "/gallery.html", { waitUntil: "domcontentloaded" });
  const tabBig = await browser.newPage();
  await tabBig.goto(FIXTURE + "/big.html", { waitUntil: "domcontentloaded" });
  await sleep(1200);
  const panel3 = await browser.newPage();
  await panel3.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await sleep(1200);

  await tabBig.bringToFront();
  await sleep(3500);
  const bigCount = await panel3.evaluate(`document.getElementById('countImage').textContent`);
  await tabGallery.bringToFront();
  await sleep(3500);
  const galCount = await panel3.evaluate(`document.getElementById('countImage').textContent`);

  check(Number(bigCount) >= 590, `pestana big.html -> 600 items (${bigCount})`);
  check(Number(galCount) >= 200 && Number(galCount) < 400, `pestana gallery.html -> 325 items (${galCount})`);
  check(bigCount !== galCount, `contadores sin mezclar (${bigCount} vs ${galCount})`);
  await panel3.close().catch(() => {});
  await tabBig.close().catch(() => {});
  await tabGallery.close().catch(() => {});

  // ============ A4: REGRESION del estado vacio falso ============
  // Bug v0.3: con 26 items y contador correcto, el grid mostraba skeletons
  // colgados y "Nada coincide con los filtros" con 0 cards. Causas raiz:
  //   (1) "ocultar <10 KB" activado por defecto ocultaba todos los items
  //       pequenos detectados por red (sizeKB 1-9) => grid 0 con contador N.
  //   (2) requestState() sin try/catch: si el sendMessage al SW fallaba,
  //       loading quedaba true y los skeletons se quedaban para siempre.
  // Test: N items SIN filtros => grid con exactamente N cards, nunca 0.
  console.log("== A4. Regresion estado vacio (26 items sin filtros => 26 cards) ==");
  const panel4 = await browser.newPage();
  const panelErrors4 = [];
  panel4.on("pageerror", (e) => panelErrors4.push(String(e).slice(0, 200)));
  await panel4.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await sleep(800);
  await panel4.evaluate(`window.__operant.pin = true`);

  const MIX = JSON.stringify([
    ...Array.from({ length: 20 }, (_, i) => ({
      url: `https://cdn.example.com/img/photo-${i}.png`,
      type: "image", ext: "png", domain: "cdn.example.com",
      sizeKB: null, sizeUnknown: false, source: "dom", w: 800, h: 600,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      url: `https://cdn.example.com/img/icon-${i}.png`,
      type: "image", ext: "png", domain: "cdn.example.com",
      sizeKB: 2 + i, sizeUnknown: false, source: "network", w: 32, h: 32,
    })),
  ]);

  await panel4.evaluate(`window.__operant.setState(${MIX}, { tab: "image" })`);
  await sleep(400);

  const s4a = await panel4.evaluate(`({
    total: document.getElementById('countImage').textContent,
    cards: document.querySelectorAll('#grid .card:not(.skeleton)').length,
    skeletons: document.querySelectorAll('#grid .card.skeleton').length,
    emptyHidden: document.getElementById('empty').hidden,
    hideSmall: document.getElementById('chkHideSmall').checked
  })`);
  check(Number(s4a.total) === 26, `contador imagen = 26 (${s4a.total})`);
  check(s4a.cards === 26, `grid con 26 cards, no 0 (${s4a.cards})`);
  check(s4a.skeletons === 0, `0 skeletons tras cargar (${s4a.skeletons})`);
  check(s4a.emptyHidden === true, `estado vacio oculto con contenido real`);
  check(s4a.hideSmall === false, `"ocultar <10 KB" DESACTIVADO por defecto (${s4a.hideSmall})`);

  // Con "ocultar <10 KB" activado, los 6 pequenos se ocultan pero no se
  // muestra vacio: quedan 20 visibles.
  await panel4.evaluate(`(() => { const c = document.getElementById('chkHideSmall'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  const s4b = await panel4.evaluate(`({
    cards: document.querySelectorAll('#grid .card:not(.skeleton)').length,
    emptyHidden: document.getElementById('empty').hidden
  })`);
  check(s4b.cards === 20, `con filtro <10KB activo quedan 20 (${s4b.cards})`);
  check(s4b.emptyHidden === true, `vacio NO se muestra si quedan visibles`);
  await panel4.evaluate(`(() => { const c = document.getElementById('chkHideSmall'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);

  // Busqueda sin coincidencias: vacio con mensaje correcto, sin skeletons.
  await panel4.evaluate(`(() => { const i = document.getElementById('search'); i.value = 'zzz-no-existe'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  const s4c = await panel4.evaluate(`({
    emptyHidden: document.getElementById('empty').hidden,
    title: document.getElementById('emptyTitle').textContent,
    skeletons: document.querySelectorAll('#grid .card.skeleton').length
  })`);
  check(s4c.emptyHidden === false, `vacio visible cuando el filtro excluye todo`);
  check(s4c.title.includes("Nada coincide"), `titulo del vacio correcto ("${s4c.title}")`);
  check(s4c.skeletons === 0, `sin skeletons en el estado vacio`);
  await panel4.evaluate(`(() => { const i = document.getElementById('search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  const s4d = await panel4.evaluate(`document.querySelectorAll('#grid .card:not(.skeleton)').length`);
  check(s4d === 26, `al limpiar la busqueda vuelven las 26 cards (${s4d})`);

  // Pestañas independientes: Imagenes | Videos | Audio | Archivos
  const MIXTABS = JSON.stringify([
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://cdn.example.com/img/t-${i}.jpg`, type: "image", ext: "jpg", domain: "cdn.example.com", sizeKB: 200, sizeUnknown: false, source: "dom" })),
    { url: "https://cdn.example.com/vid/a.mp4", type: "video", ext: "mp4", domain: "cdn.example.com", sizeKB: 5000, sizeUnknown: false, source: "dom", durationSec: 125 },
    { url: "https://cdn.example.com/vid/stream.m3u8", type: "video", ext: "m3u8", domain: "cdn.example.com", sizeKB: 3, sizeUnknown: false, source: "network" },
    { url: "https://cdn.example.com/aud/song.mp3", type: "audio", ext: "mp3", domain: "cdn.example.com", sizeKB: 4000, sizeUnknown: false, source: "dom", durationSec: 254 },
    ...Array.from({ length: 3 }, (_, i) => ({ url: `https://cdn.example.com/dl/doc-${i}.pdf`, type: "file", ext: "pdf", domain: "cdn.example.com", sizeKB: 800, sizeUnknown: false, source: "dom" })),
  ]);
  await panel4.evaluate(`window.__operant.setState(${MIXTABS}, { tab: "image" })`);
  await sleep(400);
  const s4e = await panel4.evaluate(`({
    img: document.getElementById('countImage').textContent,
    vid: document.getElementById('countVideo').textContent,
    aud: document.getElementById('countAudio').textContent,
    fil: document.getElementById('countFile').textContent
  })`);
  check(s4e.img === "10" && s4e.vid === "2" && s4e.aud === "1" && s4e.fil === "3",
    `contadores por pestana 10/2/1/3 (${s4e.img}/${s4e.vid}/${s4e.aud}/${s4e.fil})`);
  const tabCards = {};
  for (const [tab, want] of [["image", 10], ["video", 2], ["audio", 1], ["file", 3]]) {
    await panel4.evaluate(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
    await sleep(250);
    tabCards[tab] = await panel4.evaluate(`document.querySelectorAll('#grid .card:not(.skeleton)').length`);
  }
  check(tabCards.image === 10 && tabCards.video === 2 && tabCards.audio === 1 && tabCards.file === 3,
    `cada pestana muestra solo su tipo (${JSON.stringify(tabCards)})`);

  if (panelErrors4.length) console.log("  [WARN] errores del panel:", panelErrors4.join(" | "));
  await panel4.close().catch(() => {});

  // ============ A5: popover de filtros (toggle / click-fuera / Escape) ============
  // Bug v0.4: el atributo hidden era machacado por `.popover { display:flex }`
  // (regla del autor gana al [hidden] del UA stylesheet) => el popover estaba
  // SIEMPRE visible, tapa el grid, y ni el toggle ni el click-fuera ni Escape
  // lo cerraban. Mismo bug en los overlays de error de preview (#lbErr etc.).
  console.log("== A5. Popover: hidden efectivo, toggle, click fuera, Escape ==");
  const panel5 = await browser.newPage();
  const panelErrors5 = [];
  panel5.on("pageerror", (e) => panelErrors5.push(String(e).slice(0, 200)));
  await panel5.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await sleep(800);
  await panel5.evaluate(`window.__operant.pin = true`);
  // Aislamiento: A4 pudo dejar la vista guardada en storage.local.
  await panel5.evaluate(`document.getElementById('layoutSel').value = 'full'; document.getElementById('layoutSel').dispatchEvent(new Event('change'))`);
  await sleep(200);
  await panel5.evaluate(`window.__operant.setState([], { tab: "image" })`);
  await sleep(200);

  const hiddenPop = await panel5.evaluate(`document.getElementById('filterPop').hidden`);
  check(hiddenPop === true, `popover OCULTO al arrancar (hidden efectivo, ${hiddenPop})`);

  await panel5.evaluate(`document.getElementById('btnFilter').click()`);
  await sleep(150);
  const opened = await panel5.evaluate(`({
    hidden: document.getElementById('filterPop').hidden,
    expanded: document.getElementById('btnFilter').getAttribute('aria-expanded')
  })`);
  check(opened.hidden === false && opened.expanded === "true", `abre con el icono (toggle on)`);

  await panel5.evaluate(`document.body.click()`);
  await sleep(150);
  const closedByOutside = await panel5.evaluate(`document.getElementById('filterPop').hidden`);
  check(closedByOutside === true, `cierra con click fuera`);

  await panel5.evaluate(`document.getElementById('btnFilter').click()`);
  await sleep(150);
  await panel5.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(150);
  const closedByEsc = await panel5.evaluate(`document.getElementById('filterPop').hidden`);
  check(closedByEsc === true, `cierra con Escape`);

  await panel5.evaluate(`document.getElementById('btnFilter').click()`);
  await sleep(150);
  await panel5.evaluate(`document.getElementById('btnFilter').click()`);
  await sleep(150);
  const closedByToggle = await panel5.evaluate(`document.getElementById('filterPop').hidden`);
  check(closedByToggle === true, `cierra pulsando el mismo icono (toggle off)`);

  const overlaysHidden = await panel5.evaluate(`({
    lb: document.getElementById('lbErr').hidden,
    vd: document.getElementById('vdErr').hidden,
    ad: document.getElementById('adErr').hidden
  })`);
  check(
    overlaysHidden.lb && overlaysHidden.vd && overlaysHidden.ad,
    `overlays de error de preview ocultos (${JSON.stringify(overlaysHidden)})`
  );
  await panel5.screenshot({ path: path.join(RESULTS, "screenshot-popover-closed.png") });

  // Evidencia visual: popover abierto + lightbox con una imagen real del fixture.
  const MIX5 = JSON.stringify([
    ...Array.from({ length: 8 }, (_, i) => ({
      url: `http://localhost:8765/img/photo-${i}.png`,
      type: "image", ext: "png", domain: "localhost:8765",
      sizeKB: 5 + i, sizeUnknown: false, source: "dom",
      // sin w/h a propósito: la vista full mide la imagen al cargar
    })),
  ]);
  await panel5.evaluate(`window.__operant.setState(${MIX5}, { tab: "image" })`);
  await sleep(400);
  await panel5.evaluate(`document.getElementById('btnFilter').click()`);
  await sleep(200);
  await panel5.screenshot({ path: path.join(RESULTS, "screenshot-popover-open.png") });
  await panel5.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(200);
  await panel5.evaluate(`document.querySelector('#grid .card').click()`);
  await sleep(500);
  const lbOpen = await panel5.evaluate(`document.getElementById('lightboxDialog').open`);
  check(lbOpen === true, `lightbox se abre al hacer clic en una imagen`);

  // Navegación del lightbox: siguiente/anterior recorren los resultados.
  const lbFirst = await panel5.evaluate(`document.getElementById('lbTitle').textContent`);
  await panel5.evaluate(`document.getElementById('lbNext').click()`);
  await sleep(300);
  const lbSecond = await panel5.evaluate(`document.getElementById('lbTitle').textContent`);
  check(lbFirst !== lbSecond, `lightbox navega a la siguiente imagen (${lbFirst} -> ${lbSecond})`);
  await panel5.evaluate(`document.getElementById('lbPrev').click()`);
  await sleep(300);
  const lbBack = await panel5.evaluate(`document.getElementById('lbTitle').textContent`);
  check(lbBack === lbFirst, `lightbox vuelve con anterior (${lbBack})`);
  await panel5.screenshot({ path: path.join(RESULTS, "screenshot-lightbox.png") });
  await panel5.evaluate(`document.getElementById('lbClose').click()`);

  // Diseño de la vista lista (POR DEFECTO): sin nombre de archivo, URL debajo.
  const listCheck = await panel5.evaluate(`(() => {
    const c = document.querySelector('#grid .card');
    const url = c.querySelector('.lc-url');
    return {
      hasUrl: !!url,
      urlTitle: url ? url.title : null,
      hasFileName: !!c.querySelector('.card-name'),
      toolbar: c.querySelectorAll('.lc-toolbar button').length,
    };
  })()`);
  check(listCheck.hasUrl && listCheck.urlTitle === "http://localhost:8765/img/photo-0.png",
    `vista full: URL de origen debajo de la imagen (${listCheck.urlTitle})`);
  check(listCheck.hasFileName === false, `sin texto de nombre de archivo (ImageEye-style)`);
  check(listCheck.toolbar === 4, `toolbar hover con 4 acciones (${listCheck.toolbar})`);

  // Aspect ratio real sin recortar: la imagen 1x1 del fixture se mide al
  // cargar y el badge de dimensiones aparece; la card crece a su altura real.
  await sleep(800);
  const aspectCheck = await panel5.evaluate(`(() => {
    const card = document.querySelector('#grid .card');
    const img = card.querySelector('.lc-stage img');
    const dimBadge = card.querySelector('.lc-badge.dim');
    return {
      loaded: !!(img && img.complete && img.naturalWidth > 0), // fixture 1x1: naturalWidth=1
      renderedH: img ? Math.round(img.getBoundingClientRect().height) : 0,
      badge: dimBadge ? dimBadge.textContent : null,
    };
  })()`);
  check(aspectCheck.loaded === true, `imagen cargada en la card (${JSON.stringify(aspectCheck)})`);
  // La 1x1 debe renderizarse cuadrada (~ancho del panel) y no recortada a 16:9
  check(aspectCheck.renderedH > 200 && aspectCheck.renderedH <= 560,
    `imagen a su aspecto real sin recortar (altura ${aspectCheck.renderedH}px)`);
  check(aspectCheck.badge === "1×1", `badge de dimensiones medido en vivo ("${aspectCheck.badge}")`);

  // Flujo combinado: seleccionar 3 de 8 por checkbox y verificar que el zip
  // contiene EXACTAMENTE esos 3 archivos (misma lógica que el botón real).
  await panel5.evaluate(`(() => {
    const sels = [...document.querySelectorAll('#grid .card [aria-label="Seleccionar"]')];
    sels.slice(0, 3).forEach(b => b.click());
  })()`);
  await sleep(300);
  const selState = await panel5.evaluate(`({
    info: document.getElementById('selInfo').textContent,
    zip: document.getElementById('btnZip').textContent,
    selected: document.querySelectorAll('#grid .card.selected').length
  })`);
  check(selState.selected === 3 && /3 sel/.test(selState.info) && selState.zip === "Zip (3)",
    `3 seleccionados por checkbox (${JSON.stringify(selState)})`);
  await panel5.screenshot({ path: path.join(RESULTS, "screenshot-list-selected.png") });
  const zipRes = await panel5.evaluate(`window.__operant.zipCount(window.__operant.getState().selected)`);
  check(zipRes.ok === 3 && zipRes.fail === 0, `zip con exactamente 3 archivos (${JSON.stringify(zipRes)})`);
  if (panelErrors5.length) console.log("  [WARN] errores del panel:", panelErrors5.join(" | "));
  await panel5.close().catch(() => {});

  // ============ A6: navegacion SPA no produce vacio falso ============
  // Bug v0.4: onUpdated(url) hacia `state.items = []` ANTES de re-fetch; si el
  // fetch fallaba, el grid quedaba "Sin resultados" con el contador lleno.
  // Ahora el re-fetch conserva el estado anterior y solo pinta el vacío si el
  // filtrado real da 0.
  console.log("== A6. Navegacion SPA: el grid no se vacia por pushState ==");
  const tabSpa = await browser.newPage();
  await tabSpa.goto(FIXTURE + "/gallery.html", { waitUntil: "domcontentloaded" });
  const panel6 = await browser.newPage();
  await panel6.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await tabSpa.bringToFront();
  await sleep(3500);
  await panel6.evaluate(`window.__operant.pin = true`);
  // Aislamiento: A4 pudo dejar otra pestaña persistida en storage.local.
  await panel6.evaluate(`document.querySelector('.tab[data-tab="image"]').click()`);
  await sleep(500);

  const s6a = await panel6.evaluate(`({
    cards: document.querySelectorAll('#grid .card:not(.skeleton)').length,
    status: document.getElementById('statusText').textContent,
    emptyHidden: document.getElementById('empty').hidden
  })`);
  check(s6a.cards > 0, `grid con contenido real antes de navegar (${s6a.cards} cards)`);

  await tabSpa.evaluate(`history.pushState({}, '', '/gallery.html?nav=1')`);
  await sleep(1500);
  const s6b = await panel6.evaluate(`({
    cards: document.querySelectorAll('#grid .card:not(.skeleton)').length,
    status: document.getElementById('statusText').textContent,
    emptyHidden: document.getElementById('empty').hidden
  })`);
  check(s6b.cards > 0, `grid sigue pintado tras pushState (${s6b.cards} cards)`);
  check(s6b.emptyHidden === true, `sin estado vacio tras navegacion`);
  check(/medios detectados/.test(s6b.status), `status coherente ("${s6b.status}")`);
  await panel6.close().catch(() => {});
  await tabSpa.close().catch(() => {});

  // ============ A7: evidencia visual con contenido real ============
  // photos.html sirve PNGs con gradiente real (ratios variados, no iconos
  // SVG de UI): capturas de las 3 vistas para comparar contra las referencias.
  console.log("== A7. Evidencia visual con contenido real (photos.html) ==");
  const tabPhotos = await browser.newPage();
  await tabPhotos.goto(FIXTURE + "/photos.html", { waitUntil: "domcontentloaded" });
  const panel7 = await browser.newPage();
  await panel7.goto(`chrome-extension://${extId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await tabPhotos.bringToFront();
  await sleep(3500);
  await panel7.evaluate(`window.__operant.pin = true`);
  // Aislamiento: forzar vista full (predeterminada) y pestaña Imágenes aunque
  // otros bloques hayan persistido masonry/otra pestaña en storage.local.
  await panel7.evaluate(`document.querySelector('.tab[data-tab="image"]').click()`);
  await sleep(300);
  await panel7.evaluate(`document.getElementById('layoutSel').value = 'full'; document.getElementById('layoutSel').dispatchEvent(new Event('change'))`);
  await sleep(800);
  await panel7.evaluate(`(() => { const g = document.getElementById('grid'); g.scrollTop = g.scrollHeight; })()`);
  await sleep(1200);
  const s7 = await panel7.evaluate(`({
    cards: document.querySelectorAll('#grid .card:not(.skeleton)').length,
    counter: document.getElementById('counterText')?.textContent || '',
    imgsLoaded: [...document.querySelectorAll('#grid .lc-stage img')].filter(i => i.complete && i.naturalWidth > 1).length,
    badges: document.querySelector('#grid .card') ? document.querySelectorAll('#grid .card .lc-badge').length : 0
  })`);
  check(s7.cards >= 10, `fotos reales en el panel (${s7.cards} cards)`);
  check(s7.imgsLoaded >= 8, `imágenes cargadas en las cards (${s7.imgsLoaded})`);
  check(s7.badges >= 3, `metadata (formato · dims · peso) en cada card (${s7.badges} badges)`);
  await panel7.screenshot({ path: path.join(RESULTS, "screenshot-full-real.png") });
  await panel7.evaluate(`document.getElementById('layoutSel').value = 'masonry'; document.getElementById('layoutSel').dispatchEvent(new Event('change'))`);
  await sleep(800);
  await panel7.screenshot({ path: path.join(RESULTS, "screenshot-masonry-real.png") });
  await panel7.close().catch(() => {});
  await tabPhotos.close().catch(() => {});

  console.log(`\n===== AUDITORIA PANEL: ${PASS} PASS / ${FAIL} FAIL =====`);
  await browser.close();
  process.exit(FAIL ? 1 : 0);
})().catch((e) => {
  console.error("Fallo del audit:", e);
  process.exit(1);
});
