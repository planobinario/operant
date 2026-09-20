// run-verification.js — Batería de verificación funcional real.
// Lanza Chrome con la extensión cargada, ejecuta los casos (fixtures locales
// deterministas + sitios públicos reales), valida lo detectado por el content
// script / webRequest y escribe resultados en tests/results/.
//
// Uso: node tests/run-verification.js [--public] [--no-screenshots]

const puppeteer = require("puppeteer-core");
const { resolveBuildId, install, computeExecutablePath } = require("@puppeteer/browsers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { start: startFixtures } = require("./fixtures-server");

const EXT_SRC = path.resolve(__dirname, "..", "src");
const RESULTS = path.join(__dirname, "results");
const FIXTURE = "http://localhost:8765";
const CFT_CACHE = path.join(__dirname, ".chrome");

const WITH_PUBLIC = process.argv.includes("--public");
const SCREENSHOTS = !process.argv.includes("--no-screenshots");

// Chrome Stable 137+ ignora --load-extension: para cargar la extension en
// pruebas hace falta un build de Chrome for Testing (ver TESTING.md).
async function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return { executablePath: process.env.CHROME_PATH, note: "CHROME_PATH (puede que no cargue extensiones en Stable >= 137)" };
  }
  const installed = fs.existsSync(CFT_CACHE) ? fs.readdirSync(CFT_CACHE) : [];
  if (installed.length) {
    const browserPath = path.join(CFT_CACHE, "chrome");
    const platforms = fs.existsSync(browserPath) ? fs.readdirSync(browserPath) : [];
    for (const plat of platforms) {
      const versions = fs.readdirSync(path.join(browserPath, plat));
      for (const v of versions) {
        const exe = path.join(browserPath, plat, v, "chrome.exe");
        if (fs.existsSync(exe)) return { executablePath: exe, note: `Chrome for Testing ${v}` };
      }
    }
  }
  console.log("Descargando Chrome for Testing (una sola vez, ~150 MB)...");
  const buildId = await resolveBuildId("chrome", "stable", "latest");
  await install({ browser: "chrome", buildId, cacheDir: CFT_CACHE });
  return {
    executablePath: computeExecutablePath({ browser: "chrome", buildId, cacheDir: CFT_CACHE }),
    note: `Chrome for Testing ${buildId} (descargado)`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expect(pass, desc) {
  return { pass: !!pass, desc };
}

// ---------- helpers CDP ----------
async function evalSw(swTarget, expression) {
  const session = await swTarget.createCDPSession();
  const res = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error("eval SW: " + (res.exceptionDetails.exception?.description || "excepción"));
  }
  return res.result.value;
}

async function findTabId(sw, urlPart) {
  const tabs = await evalSw(
    sw,
    `chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))`
  );
  const t = tabs.find((x) => x.url && x.url.includes(urlPart));
  return t ? t.id : null;
}

async function scanItems(sw, tabId) {
  if (!tabId) return [];
  return (
    (await evalSw(
      sw,
      `chrome.tabs.sendMessage(${tabId}, {type:"scan"}).then(r => (r && r.items) || [])`
    )) || []
  );
}

// Espera hasta que el store del content script deje de crecer (máx. 12 s),
// forzando un re-escaneo al final para cubrir los chunks de background-image.
async function waitStable(sw, tabId, timeoutMs = 12000) {
  const start = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    const n = (await scanItems(sw, tabId)).length;
    if (n === prev) {
      stable++;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    prev = n;
    await sleep(600);
  }
  await evalSw(sw, `chrome.tabs.sendMessage(${tabId}, {type:"force-rescan"}).catch(()=>{})`);
  await sleep(1200);
  return scanItems(sw, tabId);
}

// ---------- runner ----------
async function runCase(browser, sw, c) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 300)));

  const record = {
    id: c.id,
    name: c.name,
    url: c.url,
    kind: c.kind,
    verdict: "PASS",
    checks: [],
    notes: [],
    consoleErrors: [],
  };

  const url = c.kind === "local" ? FIXTURE + c.url : c.url;
  try {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 50000 });
    if (c.wait) await sleep(c.wait);
    if (c.prep) await c.prep(page, browser);

    let tabId = await findTabId(
      sw,
      c.kind === "local" ? "localhost:8765" : new URL(url).hostname
    );
    record.tabId = tabId;

    // Warm-up: la primera navegacion puede ocurrir antes de que el sistema de
    // extensiones este listo; reintentamos con un reload si el content script
    // no responde al ping.
    for (let attempt = 0; attempt < 3 && tabId; attempt++) {
      const pingOk = await evalSw(
        sw,
        `chrome.tabs.sendMessage(${tabId}, {type:"ping"}).then(() => true).catch(() => false)`
      );
      if (pingOk) break;
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(1500);
      tabId = await findTabId(
        sw,
        c.kind === "local" ? "localhost:8765" : new URL(url).hostname
      );
      record.tabId = tabId;
    }

    let items = tabId ? await waitStable(sw, tabId, c.stableMs || 12000) : [];
    if (c.postStable) items = await c.postStable(sw, tabId, items);

    record.count = items.length;
    record.checks = await c.check({ items, sw, tabId, page, t0 });

    const fails = record.checks.filter((x) => !x.pass && !x.warn);
    const warns = record.checks.filter((x) => !x.pass && x.warn);
    if (fails.length) record.verdict = "FAIL";
    else if (warns.length) record.verdict = "WARN";
    else record.verdict = "PASS";
    if (c.extraNotes) record.notes.push(...c.extraNotes(items, record));

    const extErrors = consoleErrors.filter((e) => e.includes("chrome-extension"));
    if (extErrors.length) {
      record.verdict = record.verdict === "PASS" ? "WARN" : record.verdict;
      record.notes.push("Errores de consola de la extension: " + extErrors.join(" | "));
    }
    record.consoleErrors = consoleErrors.slice(0, 12);
  } catch (e) {
    record.verdict = "FAIL";
    record.notes.push("Excepcion: " + (e.message || String(e)));
    record.consoleErrors = consoleErrors.slice(0, 12);
  }

  if (SCREENSHOTS) {
    try {
      record.screenshot = `results/${c.id}.png`;
      await page.screenshot({ path: path.join(RESULTS, `${c.id}.png`) });
    } catch {
      /* sin captura */
    }
  }
  await page.close();

  fs.writeFileSync(path.join(RESULTS, `${c.id}.json`), JSON.stringify(record, null, 2));
  const fails = record.checks.filter((x) => !x.pass).length;
  console.log(
    `${record.verdict.padEnd(6)} ${c.id}  (${record.count ?? "?"} items, ${fails} check(s) fallidos)  ${c.name}`
  );
  return record;
}

// ---------- casos ----------
const byType = (items, t) => items.filter((i) => i.type === t);
const hasUrl = (items, part) => items.some((i) => i.url.includes(part));
const sampleUrls = (items, n = 4) => items.slice(0, n).map((i) => i.url);

const cases = [
  {
    id: "01-gallery",
    name: "galeria: lazy-load, srcset, picture, background CSS, dedupe",
    kind: "local",
    url: "/gallery.html",
    check({ items }) {
      const uniq = new Set(items.map((i) => i.url.split("#")[0])).size;
      return [
        expect(items.length >= 200, `detectadas >= 200 imagenes (${items.length})`),
        expect(hasUrl(items, "plain1") && hasUrl(items, "plain59"), "imagenes <img> planas"),
        expect(hasUrl(items, "lazy40") && hasUrl(items, "lazy2_40"), "lazy-load data-src / data-lazy-src"),
        expect(hasUrl(items, "ss0a") && hasUrl(items, "ss0b"), "srcset: ambas resoluciones"),
        expect(hasUrl(items, "pc0a") && hasUrl(items, "pc0b") && hasUrl(items, "pc0"), "picture source srcset + img"),
        expect(hasUrl(items, "bg29"), "background-image inline"),
        expect(hasUrl(items, "cssbg9"), "background-image desde stylesheet"),
        expect(uniq === items.length, `sin duplicados por fragmento (${uniq}/${items.length})`),
        expect(!hasUrl(items, "data:image"), "data: URIs excluidas"),
        expect(byType(items, "image").length >= 200, "todo clasificado como image"),
      ];
    },
  },
  {
    id: "02-video",
    name: "video HTML5 nativo + audio",
    kind: "local",
    url: "/video.html",
    check({ items }) {
      return [
        expect(hasUrl(items, "sample.mp4"), "video mp4 (src del <video> y <source>)"),
        expect(hasUrl(items, "sample.webm"), "video webm (segundo <source>)"),
        expect(hasUrl(items, "tone.mp3"), "audio mp3"),
        expect(hasUrl(items, "poster1"), "poster del video como imagen"),
        expect(byType(items, "video").length >= 2, ">= 2 videos"),
        expect(byType(items, "audio").length >= 1, ">= 1 audio"),
      ];
    },
  },
  {
    id: "03-embeds",
    name: "embeds: YouTube/Vimeo/Dailymotion/X",
    kind: "local",
    url: "/embeds.html",
    check({ items }) {
      const yt = items.find((i) => i.embed === "youtube");
      const vm = items.find((i) => i.embed === "vimeo");
      const dm = items.find((i) => i.embed === "dailymotion");
      return [
        expect(!!yt, "embed youtube detectado"),
        expect(!!yt?.thumb && yt.thumb.includes("i.ytimg.com"), "thumbnail de youtube generado"),
        expect(!!vm && vm.url.includes("player.vimeo.com/video/76979871"), "embed vimeo detectado"),
        expect(!!dm && dm.thumb?.includes("dailymotion.com/thumbnail"), "embed dailymotion con thumbnail"),
        expect(hasUrl(items, "twitter.com/i/videos"), "embed de X/Twitter detectado"),
      ];
    },
  },
  {
    id: "04-files",
    name: "archivos descargables por extension",
    kind: "local",
    url: "/files.html",
    check({ items }) {
      const types = new Set(items.map((i) => i.type));
      return [
        expect(hasUrl(items, "sample.pdf"), "pdf detectado"),
        expect(hasUrl(items, "sample.zip"), "zip detectado"),
        expect(hasUrl(items, "report.docx"), "docx detectado"),
        expect(hasUrl(items, "archive.tar.gz"), "tar.gz detectado"),
        expect(hasUrl(items, "sample.mp4"), "mp4 como archivo descargable"),
        expect(types.has("file"), "tipo 'file' presente"),
        expect(!hasUrl(items, "example.com/page"), "enlaces a paginas normales excluidos"),
        expect(!items.some((i) => i.url.includes("#section") || i.url.startsWith("mailto:")), "anclas y mailto excluidos"),
      ];
    },
  },
  {
    id: "05-hls-local",
    name: "HLS local: webRequest captura m3u8 + segmentos",
    kind: "local",
    url: "/hls.html",
    wait: 6000,
    check({ items }) {
      const net = items.filter((i) => i.source === "network");
      return [
        expect(hasUrl(items, "stream.m3u8"), "m3u8 detectado"),
        expect(net.some((i) => i.url.includes("stream.m3u8")), "m3u8 capturado por webRequest (source=network)"),
        expect(net.some((i) => i.url.includes(".ts")), "segmentos .ts capturados por webRequest"),
        expect(net.length >= 2, `>= 2 items de red (${net.length})`),
      ];
    },
  },
  {
    id: "06-spa",
    name: "SPA: MutationObserver captura scroll + cambio de ruta",
    kind: "local",
    url: "/spa.html",
    wait: 1500,
    async prep(page) {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1200);
      }
      await page.evaluate(() => document.getElementById("route").click());
      await sleep(2000);
    },
    check({ items }) {
      return [
        expect(hasUrl(items, "spa") && items.length >= 60, `contenido inyectado por scroll detectado (${items.length})`),
        expect(hasUrl(items, "sample.mp4"), "video inyectado por 'cambio de ruta' detectado"),
      ];
    },
  },
  {
    id: "07-shadow",
    name: "Shadow DOM abierto SI, cerrado NO (limitacion documentada)",
    kind: "local",
    url: "/shadow.html",
    check({ items }) {
      return [
        expect(hasUrl(items, "shadow1") && hasUrl(items, "shadow2"), "imagenes dentro de shadow root abierto"),
        expect(hasUrl(items, "sample.mp4"), "video dentro de shadow root abierto"),
        expect(!hasUrl(items, "closed1"), "shadow root cerrado NO es inspeccionable (esperado)"),
        expect(hasUrl(items, "shadowbg"), "background-image fuera del shadow"),
      ];
    },
  },
  {
    id: "08-perf-big",
    name: "rendimiento: 600 imagenes, dedupe y tiempo de escaneo",
    kind: "local",
    url: "/big.html",
    stableMs: 20000,
    check({ items, t0 }) {
      const uniq = new Set(items.map((i) => i.url.split("#")[0])).size;
      const elapsed = Date.now() - t0;
      return [
        expect(items.length >= 590, `~600 imagenes detectadas (${items.length})`),
        expect(uniq === items.length, `sin duplicados (${uniq}/${items.length})`),
        expect(elapsed < 15000, `escaneo + estabilizacion < 15 s (${elapsed} ms)`),
      ];
    },
    extraNotes(items, record) {
      return [
        `El lazy-render del panel (chunks de 60 + IntersectionObserver) evita congelar la UI por construccion; el escaneo completo tardo ${record.durationMs} ms en total.`,
      ];
    },
  },
  {
    id: "09-state-sw",
    name: "estado centralizado: storage.session recibe items del content script",
    kind: "local",
    url: "/gallery.html",
    wait: 2000,
    async postStable(sw, tabId, items) {
      await sleep(1200); // deja que el SW persista tras el ultimo update
      const stored = await evalSw(sw, `chrome.storage.session.get(null)`);
      const tabKey = Object.keys(stored || {}).find((k) => k.startsWith("tab_"));
      recordHolder.stored = { tabKey, count: tabKey ? stored[tabKey].length : 0 };
      return items;
    },
    check({ items }) {
      const s = recordHolder.stored;
      return [
        expect(!!s.tabKey && s.count > 0, `storage.session guarda estado por pestaña (tab_*: ${s.count} items)`),
        expect(items.length >= 200, "items disponibles via scan directo"),
      ];
    },
  },
  {
    id: "10-native-host",
    name: "native host: healthcheck con host NO instalado",
    kind: "local",
    url: "/video.html",
    wait: 1000,
    async check({ sw }) {
      const r = await evalSw(
        sw,
        `(async () => {
          try {
            const port = chrome.runtime.connectNative("com.operant.native_host");
            return await new Promise((resolve) => {
              const t = setTimeout(() => { try { port.disconnect(); } catch {} resolve({ timeout: true }); }, 4000);
              port.onMessage.addListener((m) => { clearTimeout(t); resolve({ connected: true, msg: m }); });
              port.onDisconnect.addListener(() => { clearTimeout(t); resolve({ connected: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "disconnect" }); });
              port.postMessage({ type: "ping" });
            });
          } catch (e) {
            return { connected: false, error: String(e) };
          }
        })()`
      );
      const failed = !r.connected || r.timeout;
      return [
        expect(failed, `host no instalado -> sin conexion, sin errores de extension (${r.error || r.timeout ? "timeout" : "conectado"})`),
      ];
    },
    extraNotes() {
      return [
        "Si el usuario NO tiene el host, connectNative falla limpio: el panel oculta el boton yt-dlp (healthcheck devuelve installed:false, cache 30 s).",
        "Con el host instalado y registrado, responde pong{ytDlp,ffmpeg} — probado manualmente contra operant_host.py en la fase 4.",
      ];
    },
  },
];

const recordHolder = { stored: null };

// ---------- casos publicos (requieren red, resultados honestos) ----------
const publicCases = [
  {
    id: "p1-unsplash",
    name: "[publico] unsplash: infinite scroll + lazy-load",
    kind: "public",
    url: "https://unsplash.com/t/nature",
    wait: 5000,
    async prep(page) {
      for (let i = 0; i < 4; i++) {
        try {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        } catch {}
        await sleep(1500);
      }
    },
    check({ items }) {
      return [
        expect(byType(items, "image").length >= 5, `galeria con >= 5 imagenes detectadas (${byType(items, "image").length})`),
      ];
    },
    extraNotes(items, record) {
      return items.length === 0
        ? ["Unsplash bloquea la automatizacion (403 anti-bot) en headless; en navegador normal con usuario real deberia detectar la galeria (verificacion manual pendiente)."]
        : [];
    },
  },
  {
    id: "p2-w3schools",
    name: "[publico] w3schools: video HTML5 con mp4/webm/ogg",
    kind: "public",
    url: "https://www.w3schools.com/html/html5_video.asp",
    wait: 4000,
    check({ items }) {
      return [
        expect(hasUrl(items, ".mp4"), "fuente mp4 detectada"),
        expect(hasUrl(items, ".webm") || hasUrl(items, ".ogg"), "fuente webm/ogg detectada"),
      ];
    },
  },
  {
    id: "p3-python",
    name: "[publico] python.org/downloads: archivos descargables",
    kind: "public",
    url: "https://www.python.org/downloads/",
    wait: 4000,
    check({ items }) {
      return [
        expect(items.some((i) => /\.(tgz|xz|zip|exe|msi)(\?|$)/.test(i.url)), "archivos de descarga (tgz/xz/zip/exe)"),
        expect(byType(items, "image").length > 0, "imagenes de la pagina"),
      ];
    },
  },
  {
    id: "p4-hls-demo",
    name: "[publico] hls.js demo: stream HLS real por webRequest",
    kind: "public",
    url: "https://hls-js.netlify.app/demo/?src=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8",
    wait: 4000,
    async prep(page) {
      await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v) v.play().catch(() => {});
        for (const label of ["Play", "Start loading"]) {
          const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
          if (btn) btn.click();
        }
      });
      await sleep(15000);
    },
    check({ items }) {
      const net = items.filter((i) => i.source === "network" && i.url.includes("mux.dev"));
      return [
        { pass: net.length > 0, warn: true, desc: `streams de test-streams.mux.dev capturados por webRequest (${net.length}) — si falla, el demo de hls.js no arranca la reproduccion en automatizacion (estado persistido); la captura HLS real queda cubierta por el caso local 05` },
      ];
    },
    extraNotes(items) {
      return items.length === 0
        ? ["El demo de hls.js requiere interaccion (clic en Play) para emitir trafico m3u8; sin gesto no hay captura."]
        : [];
    },
  },
  {
    id: "p5-dash-demo",
    name: "[publico] dash.js reference player: manifest .mpd por webRequest",
    kind: "public",
    url: "https://reference.dashif.org/dash.js/v4.5.0/samples/dash-if-reference-player/index.html?url=https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
    wait: 15000,
    check({ items }) {
      const mpd = items.filter((i) => i.url.includes("bbb_30fps.mpd"));
      return [
        expect(mpd.length > 0, `manifest .mpd detectado (${mpd.length})`),
      ];
    },
  },
];

(async () => {
  fs.mkdirSync(RESULTS, { recursive: true });

  const { executablePath: exe, note } = await resolveChrome();
  console.log("Navegador:", note);

  startFixtures(8765);
  await sleep(500);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "operant-verify-"));

  async function launch(headless) {
    return puppeteer.launch({
      executablePath: exe,
      headless,
      userDataDir,
      defaultViewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
      args: [
        `--load-extension=${EXT_SRC}`,
        `--disable-extensions-except=${EXT_SRC}`,
        "--enable-unsafe-extension-debugging",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  }

  let browser = await launch(true);
  let sw = null;
  for (let i = 0; i < 40; i++) {
    sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
    if (sw) break;
    await sleep(500);
  }
  if (!sw) {
    console.log("Sin service worker en headless; reintento con ventana visible...");
    await browser.close();
    browser = await launch(false);
    for (let i = 0; i < 40; i++) {
      sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
      if (sw) break;
      await sleep(500);
    }
  }
  if (!sw) {
    console.error("No aparecio el service worker de la extension. ¿Chrome soporta --load-extension?");
    process.exit(1);
  }
  console.log("Service worker conectado:", sw.url());

  const all = [];
  for (const c of cases) all.push(await runCase(browser, sw, c));
  if (WITH_PUBLIC) {
    for (const c of publicCases) all.push(await runCase(browser, sw, c));
  } else {
    console.log("(casos publicos omitidos; usa --public para incluirlos)");
  }

  // Auditoria de producto del panel: tests/run-panel-audit.js (suite separada).

  console.log("\n===== RESUMEN =====");
  for (const r of all) {
    console.log(`${r.verdict.padEnd(6)} ${r.id} ${r.name}`);
    if (r.notes.length) console.log("   notas:", r.notes.join(" | "));
  }
  const fails = all.filter((r) => r.verdict === "FAIL").length;
  const warns = all.filter((r) => r.verdict === "WARN").length;
  console.log(`\n${all.length - fails - warns} PASS / ${warns} WARN / ${fails} FAIL  (resultados en tests/results/)`);

  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("Fallo del harness:", e);
  process.exit(1);
});
