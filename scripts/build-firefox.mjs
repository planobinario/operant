// build-firefox.mjs — Genera dist-firefox/ desde src/ con el manifest
// parcheado al formato de Gecko. Un solo árbol de fuentes, dos targets.
//
// Lo que se traduce y POR QUÉ (esto no era cosmético: la extensión estaba
// declarada como multi-navegador pero su punto de entrada principal NO existía en
// Gecko, y el fallo quedaba oculto por un `.catch(() => {})`):
//
//   background.service_worker  → background.scripts
//     Firefox MV3 no implementa service workers. Sin esto, el manifest se
//     rechaza en la instalación.
//
//   side_panel.default_path    → sidebar_action.default_panel
//     `chrome.sidePanel` es una API EXCLUSIVA de Chromium. Firefox usa
//     `sidebar_action` + `browser.sidebarAction`. Con `side_panel` en el
//     manifest, el icono de la barra no abría nada en Firefox.
//
//   permiso "sidePanel"        → se elimina
//     Firefox no conoce ese permiso y addons-linter lo marca como inválido.
//
//   key                        → se elimina
//     El ID de un add-on lo deriva Firefox del `browser_specific_settings.gecko.id`.
//     Dejar la clave de Chromium haría que el XPI tuviera un ID distinto al
//     esperado por el registro del host nativo.
import { cpSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const out = join(root, "dist-firefox");

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const manifestPath = join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (!manifest.background?.service_worker) {
  throw new Error("src/manifest.json no define background.service_worker");
}

delete manifest.key;

manifest.background = {
  scripts: [manifest.background.service_worker],
  ...(manifest.background.type ? { type: manifest.background.type } : {}),
};

// --- side_panel → sidebar_action ---
if (manifest.side_panel?.default_path) {
  const action = manifest.action || {};
  manifest.sidebar_action = {
    default_panel: manifest.side_panel.default_path,
    ...(action.default_title ? { default_title: action.default_title } : {}),
    ...(action.default_icon ? { default_icon: action.default_icon } : {}),
  };
  delete manifest.side_panel;
}

// Firefox no conoce el permiso `sidePanel`: declararlo es ruido que el
// linter marca como inválido.
if (Array.isArray(manifest.permissions)) {
  manifest.permissions = manifest.permissions.filter((p) => p !== "sidePanel");
}

// --- Punto de entrada del panel: sustituir por la variante de Gecko ---
//
// `background.js` importa `./panel-entry-chromium.js`, que contiene una
// referencia a `chrome.sidePanel`. En el paquete de Firefox se cambia el
// fichero por su equivalente de Gecko, de modo que el XPI no contiene NINGUNA
// referencia a una API que Firefox no implementa (y addons-linter deja de
// marcar UNSUPPORTED_API sin que haya que ocultar nada).
//
// El resultado se llama `panel-entry.js`, NO `panel-entry-chromium.js`.
//
// Antes se renombraba el fichero de Gecko a `panel-entry-chromium.js` para no
// tener que reescribir el import. Funcionaba, pero dejaba el XPI con un fichero
// llamado "chromium" que contiene código de Gecko: al auditar el paquete, un
// revisor ve "chromium" y o bien busca una API de Chromium que no está, o peor,
// da por hecho que la build de Firefox se parece a la de Chromium y no la mira.
// Un nombre neutro hace imposible esa confusión, y reescribir un import no
// cuesta nada.
const chromiumEntry = "panel-entry-chromium.js";
const geckoEntry = "panel-entry-gecko.js";
const neutralEntry = "panel-entry.js";
if (!existsSync(join(out, chromiumEntry)) || !existsSync(join(out, geckoEntry))) {
  throw new Error(`faltan ${chromiumEntry} o ${geckoEntry} en src/`);
}
rmSync(join(out, chromiumEntry), { force: true });
rmSync(join(out, neutralEntry), { force: true });
renameSync(join(out, geckoEntry), join(out, neutralEntry));

// El import de background.js debe apuntar al nombre neutral.
const bgPath = join(out, "background.js");
const bg = readFileSync(bgPath, "utf8");
const patched = bg.replace(
  new RegExp(`["'\\./]*${chromiumEntry.replace(".", "\\.")}["']`, "g"),
  `"./${neutralEntry}"`
);
if (patched === bg) {
  throw new Error(
    `background.js no importa ${chromiumEntry}: el paquete de Firefox se quedaría sin punto de entrada del panel.`
  );
}
writeFileSync(bgPath, patched);

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  "dist-firefox/ generado: background.scripts + sidebar_action " +
    "(side_panel y el permiso sidePanel eliminados; key eliminada; " +
    `punto de entrada del panel sustituido por ${neutralEntry} (variante de Gecko).)`
);
