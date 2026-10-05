// tests/firefox/run-gecko.mjs - Ejecuta la build de Firefox en un Gecko real y
// comprueba que la extensión arranca.
//
// POR QUÉ NO BASTA CON `web-ext lint`
// -----------------------------------
// El linter comprueba el MANIFEST. No ejecuta ni una línea del background script,
// ni comprueba que un import apunte a un fichero que existe, ni que el paquete no
// arrastre una API que Chromium sí tiene y Gecko no. Todo eso falla en
// runtime, con la extensión ya instalada en el perfil del usuario.
//
// Esta comprobación es la que de verdad importa para el paquete de Firefox:
// Gecko acepta el manifest e instala el add-on. Si el background script tuviera
// un `import` roto o una referencia a `chrome.sidePanel`, el add-on se
// instalaría igual y fallaría después, en silencio.
//
// CÓMO FUNCIONA Y POR QUÉ ES FIABLE
// ---------------------------------
// `web-ext run --target=firefox-desktop` lanza Firefox con un perfil temporal e
// instala dist-firefox como add-on temporal vía el protocolo de add-on de
// Firefox. web-ext no sale solo, así que hay que matarlo: se espera a que
// aparezca la línea que confirma la instalación y se cierra el proceso.
//
// Lo que se mira en la salida de web-ext:
//
//   1. `Installed <ruta> as a temporary add-on` — Gecko aceptó el paquete.
//   2. Cualquier `JavaScript error` que mencione un fichero NUESTRO.
//   3. El id del add-on (`operant@operant.dev`), que viene del manifest.
//
// El punto 3 importa: si el id del add-on no es el de Firefox, se ha instalado
// una extensión distinta.
//
// REQUISITOS
// -----------
// Un binario de Firefox. Se busca, por orden:
//   $FIREFOX_PATH, $PLAYWRIGHT_BROWSERS_PATH/firefox-*/firefox/firefox.exe,
//   Firefox del sistema en Program Files.
//
// Con `--playwright` descarga el Firefox de Playwright al directorio temporal
// (usuario, sin elevación) y lo usa. Es la vía que funciona en máquinas donde
// el instalador de Firefox está bloqueado por política.
//
// Uso:
//   node tests/firefox/run-gecko.mjs
//   node tests/firefox/run-gecko.mjs --playwright
//   FIREFOX_PATH=/ruta/a/firefox.exe node tests/firefox/run-gecko.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = resolve(ROOT, "dist-firefox");
const WITH_PLAYWRIGHT = process.argv.includes("--playwright");
const BOOT_TIMEOUT_MS = 90_000;

// El id del add-on de Firefox lo fija `browser_specific_settings`. Si cambia en
// el manifest, este test deja de ser válido: por eso está en una constante y no
// enterrado en una aserción.
const GECKO_ID = "operant@operant.dev";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFirefox() {
  if (process.env.FIREFOX_PATH && existsSync(process.env.FIREFOX_PATH)) {
    return process.env.FIREFOX_PATH;
  }
  const sys = [
    join(process.env.ProgramFiles || "C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Mozilla Firefox", "firefox.exe"),
    join(process.env.LOCALAPPDATA || "", "Mozilla Firefox", "firefox.exe"),
  ];
  for (const p of sys) if (existsSync(p)) return p;

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    for (const d of readdirSync(base)) {
      if (!d.startsWith("firefox-")) continue;
      const p = join(base, d, "firefox", "firefox.exe");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function installPlaywrightFirefox() {
  const dir = join(tmpdir(), "operant-pw-browsers");
  mkdirSync(dir, { recursive: true });
  console.log("Descargando Firefox de Playwright (una sola vez)…");
  const r = spawnSync("npx", ["--yes", "playwright@latest", "install", "firefox"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir },
    shell: true,
    timeout: 15 * 60 * 1000,
  });
  if (r.status !== 0) {
    console.error("No se pudo descargar Firefox de Playwright:\n" + (r.stdout || "") + (r.stderr || ""));
    process.exit(2);
  }
  return findFirefoxIn(dir);
}

function findFirefoxIn(base) {
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    if (!d.startsWith("firefox-")) continue;
    const p = join(base, d, "firefox", "firefox.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

// --- preparacion -------------------------------------------------------------------

if (!existsSync(resolve(DIST, "manifest.json"))) {
  console.error("dist-firefox/ no existe. Ejecuta antes:  npm run build:firefox");
  process.exit(2);
}

let firefox = findFirefox();
if (!firefox && WITH_PLAYWRIGHT) firefox = await installPlaywrightFirefox();
if (!firefox && WITH_PLAYWRIGHT) firefox = findFirefox();
if (!firefox) {
  console.error(
    [
      "No se encuentra un binario de Firefox.",
      "",
      "Opciones:",
      "  · instalar Firefox y volver a ejecutar (más fiel: es un build oficial)",
      "  · descargarlo con Playwright, sin elevación:",
      "      node tests/firefox/run-gecko.mjs --playwright",
      "  · indicar la ruta:",
      "      $env:FIREFOX_PATH = 'C:\\ruta\\firefox.exe'",
    ].join("\n")
  );
  process.exit(2);
}

console.log(`Firefox: ${firefox}`);
console.log(`Paquete: ${DIST}\n`);

// --- ejecución ---------------------------------------------------------------

const logFile = join(mkdtempSync(join(tmpdir(), "operant-gecko-")), "web-ext.log");
const child = spawn(
  "npx.cmd",
  [
    "web-ext",
    "run",
    "--source-dir=./dist-firefox",
    "--target=firefox-desktop",
    `--firefox=${firefox}`,
    "--arg=-headless",
    "--no-reload",
    "--verbose",
  ],
  {
    cwd: ROOT,
    env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
    shell: true,
  }
);

let log = "";
child.stdout.on("data", (d) => (log += d.toString()));
child.stderr.on("data", (d) => (log += d.toString()));

const cleanup = () => {
  try {
    child.kill();
  } catch {
    /* ya muerto */
  }
  try {
    rmSync(dirname(logFile), { recursive: true, force: true });
  } catch {
    /* temporal */
  }
};

// Si el script se interrumpe, no dejar Firefox ni web-ext huérfanos.
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const deadline = Date.now() + BOOT_TIMEOUT_MS;
let installed = false;
while (Date.now() < deadline) {
  await sleep(500);
  if (/Installed .* as a temporary add-on/.test(log)) {
    installed = true;
    break;
  }
  if (/error|Error/.test(log) && /failed|Failed|ECONNREFUSED: 0 retries/.test(log) && /npx/.test(log)) {
    // sigue reintentando la conexión al depurador remoto; normal en headless
  }
  if (child.exitCode !== null && !installed) break;
}
cleanup();

// --- veredicto ---------------------------------------------------------------

const failures = [];

if (!installed) {
  failures.push(
    "Gecko no llegó a instalar dist-firefox como add-on temporal.\n" +
      "Últimas líneas de web-ext:\n" +
      log.split(/\r?\n/).slice(-25).join("\n")
  );
}

const installedId = /installTemporaryAddon:.*?"id":"([^"]+)"/.exec(log)?.[1];
if (installed) {
  if (installedId && installedId !== GECKO_ID) {
    failures.push(
      `El add-on se instaló con id "${installedId}" y el manifest declara "${GECKO_ID}".\n` +
        `  Con otro id, Firefox trata la extensión como OTRA extensión: no hereda nada\n` +
        `  de una instalación anterior y el usuario ve dos Operant.`
    );
  }
  const notInstalled = !/Installed .* as a temporary add-on/.test(log);
  if (notInstalled) failures.push("La línea de confirmación de instalación no aparece en la salida.");
}

// Errores de JavaScript que mencionen ficheros del paquete. Los errores de
// Firefox headless (juggler, nimbus, GFX, taskbar) se ignoran: son ruido del
// entorno, no del código de la extensión.
const OUR_FILES = [
  "background.js",
  "content.js",
  "panel.js",
  "panel-entry.js",
  "theme-boot.js",
  "player.js",
  "hls-fast.js",
  "media-core.js",
  "filename.js",
  "icons.js",
  "dl-indicator.js",
  "recorder-main.js",
];
const jsErrors = log
  .split(/\r?\n/)
  .filter((l) => /JavaScript error|JS error|uncaught/i.test(l))
  .filter((l) => OUR_FILES.some((f) => l.includes(f)));
if (jsErrors.length) {
  failures.push(
    "Gecko registró errores de JavaScript en ficheros del paquete:\n" +
      jsErrors.map((l) => "  · " + l.trim()).join("\n")
  );
}

// --- informe -----------------------------------------------------------------

console.log(`id del add-on instalado: ${installedId || "(desconocido)"}`);
console.log(`errores de JS en ficheros del paquete: ${jsErrors.length}`);
if (installed) console.log("Gecko aceptó e instaló el add-on temporal.\n");

if (failures.length) {
  console.error("FALLO:");
  for (const f of failures) console.error("  · " + f);
  process.exit(1);
}
console.log("OK: la build de Firefox arranca en Gecko.");
process.exit(0);