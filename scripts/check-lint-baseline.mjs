// scripts/check-lint-baseline.mjs — Congela la deuda conocida de lint y
// falla ante cualquier deuda NUEVA.
//
// POR QUÉ NO BASTA CON `--warnings-as-errors`
// -------------------------------------------
// Ponerlo hace la CI roja desde el primer día por 20 avisos que nadie ha
// revisado todavía, y la reacción natural sería subir el umbral o silenciar el
// linter. Peor: un `--warnings-as-errors` que alguien relaja una vez ya no
// vuelve a detectar nada.
//
// Lo que hace este script en su lugar:
//   · ejecuta addons-linter y lee el JSON;
//   · falla si hay CUALQUIER error (nunca se perdona un error);
//   · falla si aparece un código de aviso que no está en el baseline;
//   · falla si un código crece por encima de lo registrado.
//
// El resultado: el número de avisos solo puede BAJAR. La deuda queda anotada y
// justificada fichero a fichero en lint-baseline.json, y añadir un innerHTML
// nuevo obliga a decidir si es seguro.
//
// Uso:  node scripts/check-lint-baseline.mjs
// Requiere que exista dist-firefox/ (npm run build:firefox).

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(resolve(ROOT, "lint-baseline.json"), "utf8"));

if (!existsSync(resolve(ROOT, "dist-firefox/manifest.json"))) {
  console.error("dist-firefox/ no existe. Ejecuta `npm run build:firefox` antes de este check.");
  process.exit(1);
}

// `npx` no es un ejecutable en Windows: se invoca a través del shell que lo
// acompaña, o se llama directamente al binario local de web-ext si está
// instalado (que es lo que hace `npm run`, sin descargar nada de la red).
function runLinter() {
  const candidates = [
    { file: process.platform === "win32" ? "npx.cmd" : "npx", args: ["--yes", "web-ext", "lint", "--source-dir=./dist-firefox", "--output=json"] },
    { file: "node", args: [resolve(ROOT, "node_modules/web-ext/bin/web-ext.js"), "lint", "--source-dir=./dist-firefox", "--output=json"] },
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      return execFileSync(c.file, c.args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      // addons-linter sale con código distinto de 0 si hay errores, pero su
      // salida JSON sigue siendo válida: hay que leerla igualmente. Solo se
      // considera fallido el intento si no produjo nada usable.
      if (e.stdout && String(e.stdout).trim()) return String(e.stdout);
      lastErr = e;
    }
  }
  throw lastErr || new Error("no se pudo ejecutar addons-linter");
}

let raw = "";
try {
  raw = runLinter();
} catch (e) {
  console.error("no se pudo ejecutar addons-linter:", String(e.message || e));
  process.exit(1);
}

// A veces el JSON viene precedido de líneas de log.
const start = raw.indexOf("{");
if (start < 0) {
  console.error("addons-linter no devolvió JSON legible.");
  process.exit(1);
}
let report;
try {
  report = JSON.parse(raw.slice(start));
} catch (e) {
  console.error("no se pudo parsear el JSON de addons-linter:", String(e.message || e));
  process.exit(1);
}

const errors = report.errors || [];
const warnings = report.warnings || [];
const notices = report.notices || [];

const failures = [];

if (errors.length > 0) {
  failures.push(`${errors.length} error(es) de addons-linter (nunca se aceptan):`);
  for (const e of errors.slice(0, 10)) failures.push(`  · [${e.code}] ${e.file}: ${e.message}`);
}

// Código -> recuento observado
const observed = new Map();
for (const w of warnings) observed.set(w.code, (observed.get(w.code) || 0) + 1);

const isVendor = (file) => /vendor\//.test(file || "");
let ownUnsafe = 0;
let vendorEval = 0;
for (const w of warnings) {
  if (w.code === "UNSAFE_VAR_ASSIGNMENT" && !isVendor(w.file)) ownUnsafe++;
  if (w.code === "DANGEROUS_EVAL" && isVendor(w.file)) vendorEval++;
}

if (ownUnsafe > baseline.ownUNSAFE_VAR_ASSIGNMENT) {
  failures.push(
    `UNSAFE_VAR_ASSIGNMENT en código propio: ${ownUnsafe} > ${baseline.ownUNSAFE_VAR_ASSIGNMENT} del baseline. ` +
      `Si el nuevo innerHTML recibe datos de la página, es inyección: usa textContent o DOM. ` +
      `Si es un SVG estático como los existentes, demuestra que lo cubre tests/unit/icons.test.js.`
  );
}
if (vendorEval > baseline.vendorDANGEROUS_EVAL) {
  failures.push(`DANGEROUS_EVAL en vendor: ${vendorEval} > ${baseline.vendorDANGEROUS_EVAL} del baseline.`);
}

// Cualquier código de aviso que no sea uno de los dos conocidos es nuevo.
const known = new Set(["UNSAFE_VAR_ASSIGNMENT", "DANGEROUS_EVAL"]);
for (const [code, count] of observed) {
  if (!known.has(code)) {
    failures.push(`Aviso NUEVO sin baseline: ${code} (${count}). Añádelo a lint-baseline.json con su justificación.`);
  }
}

const total = warnings.length;
if (total > baseline.total) {
  failures.push(`Total de avisos ${total} > ${baseline.total} del baseline. El baseline solo puede bajar.`);
}

console.log(
  `addons-linter: ${errors.length} errores · ${total} avisos ` +
    `(${ownUnsafe} innerHTML en código propio con invariante cubierta por tests/unit/icons.test.js, ` +
    `${vendorEval} en vendor) · ${notices.length} avisos informativos`
);

if (failures.length) {
  console.error("\nLa validación del paquete falla:");
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("Baseline respetado (sin errores, sin avisos nuevos).");
