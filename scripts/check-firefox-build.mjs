// scripts/check-firefox-build.mjs — El build de Firefox no puede quedarse obsoleto.
//
// `dist-firefox/` estaba en 0.4.0 mientras `src/` iba a 0.4.1, y le faltaban
// los archivos nuevos (`panel/player.html`, `shared/icons.js`). Nadie lo notó
// porque `npm run build:firefox` no se ejecutaba nunca: el directorio se
// versiona-desactualizado en silencio.
//
// Además se comprueba que el manifest de Firefox no lleve `key` (el XPI obtiene
// su ID del add-on, y `build-firefox.mjs` ya la borra) y que la versión
// coincida con la de Chromium, que es lo que espera el host nativo compartido.
//
// Uso:  node scripts/check-firefox-build.mjs

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const srcManifest = JSON.parse(readFileSync(resolve(ROOT, "src/manifest.json"), "utf8"));

const ffManifestPath = resolve(ROOT, "dist-firefox/manifest.json");
if (!existsSync(ffManifestPath)) {
  console.error("dist-firefox/manifest.json no existe. Ejecuta `npm run build:firefox`.");
  process.exit(1);
}
const ff = JSON.parse(readFileSync(ffManifestPath, "utf8"));

if (ff.version !== srcManifest.version) {
  errors.push(
    `dist-firefox/manifest.json version "${ff.version}" != src "${srcManifest.version}". ` +
      "La build de Firefox está obsoleta: ejecuta `npm run build:firefox`."
  );
}

if (ff.key) {
  errors.push(
    "dist-firefox/manifest.json conserva `key`. En Firefox el ID lo deriva el add-on; " +
      "dejarla hace que el XPI tenga un ID distinto al de Chromium, con lo que el host " +
      "nativo compartido queda registrado contra un origen que ya no existe."
  );
}

// Archivos que la extensión necesita y que un build obsoleto no copiaría.
const required = [
  "background.js",
  "content.js",
  "recorder-main.js",
  "shared/media-core.js",
  "shared/hls-fast.js",
  "shared/dl-indicator.js",
  "shared/icons.js",
  "shared/filename.js",
  "panel/panel.html",
  "panel/panel.js",
  "panel/panel.css",
  "panel/player.html",
];
for (const rel of required) {
  if (!existsSync(resolve(ROOT, "dist-firefox", rel))) {
    errors.push(`dist-firefox/${rel} falta: la build de Firefox está incompleta o obsoleta.`);
  }
}

// Firefox NO implementa sidePanel (la API de Chrome). El manifest declara
// side_panel, así que el punto de entrada principal no existe en Gecko y el
// fallo queda oculto por un .catch(() => {}) en background.js.
const hasSidePanel = !!(ff.side_panel || ff.sidebar_action);
if (!hasSidePanel) {
  errors.push(
    "El manifest de Firefox no declara ni side_panel ni sidebar_action: en Gecko no " +
      "existe chrome.sidePanel, así que el panel lateral no se abre."
  );
}

if (errors.length) {
  console.error(`\nBuild de Firefox inválida (${errors.length}):`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}

console.log(`Build de Firefox coherente con src (v${ff.version}).`);
