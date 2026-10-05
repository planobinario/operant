// scripts/check-manifest.mjs - El manifest no puede mentir sobre lo que la
// extensión usa, ni sobre qué navegador necesita.
//
// POR QUÉ EXISTE
// --------------
// `activeTab` estaba declarado y no se usaba en ninguna parte del código. Es
// exactamente el tipo de permiso que las tiendas marcan para revisión y que
// nadie se para a quitar porque "no hace daño". Aquí no hizo daño; en la tienda
// sí, y mientras siga declarado el revisor no puede saber si es un descuido o si
// hay algo que no estamos viendo.
//
// El otro fallo que este script evita es declarativo: `minimum_chrome_version`
// es una promesa. Si el código empieza a usar una API más nueva y nadie la
// actualiza, la promesa es falsa y el fallo aparece en el navegador de un
// usuario, no en la CI.
//
// QUÉ COMPRUEBA
// -------------
//   1. Cada permiso declarado se usa de verdad en el código (con alias para los
//      que no comparten nombre con su API, como nativeMessaging).
//   2. Ningún permiso declarado queda sin uso, y ningún permiso usado falta.
//   3. `minimum_chrome_version` >= la versión más alta que exigen las APIs que
//      el código usa realmente, según la tabla de abajo.
//   4. Toda API usada que no esté en la tabla se avisa: hay que declararla, no
//      heredarla por descuido.
//   5. El paquete de Firefox no declara APIs que solo existen en Chromium.
//
// Uso:  node scripts/check-manifest.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const errors = [];
const warnings = [];
const notes = [];

// --- fuentes de código --------------------------------------------------------

const SOURCE_DIRS = ["src"];
const sources = [];
function collect(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "vendor") continue; // código de terceros
      collect(full);
    } else if (entry.endsWith(".js")) {
      sources.push({ file: relative(ROOT, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
    }
  }
}
for (const d of SOURCE_DIRS) {
  const abs = resolve(ROOT, d);
  if (existsSync(abs)) collect(abs);
}
if (!sources.length) {
  console.error("no se encontró código en src/");
  process.exit(2);
}
const all = sources.map((s) => s.text).join("\n");

// --- 1 y 2: permisos declarados vs. usados ------------------------------------
//
// El nombre del permiso no siempre coincide con el de la API. `nativeMessaging`
// no tiene `chrome.nativeMessaging`: su superficie real es
// `chrome.runtime.connectNative`. Sin este mapa, el guard marcaría como muerto un
// permiso que sí se usa, y el equipo acabaría borrándolo.

const PERMISSION_API = {
  storage: /\bchrome\.storage\./,
  sidePanel: /\bchrome\.sidePanel\./,
  downloads: /\bchrome\.downloads\./,
  webRequest: /\bchrome\.webRequest\./,
  webNavigation: /\bchrome\.webNavigation\./,
  nativeMessaging: /\bchrome\.runtime\.connectNative\b/,
  declarativeNetRequest: /\bchrome\.declarativeNetRequest\b/,
  scripting: /\bchrome\.scripting\./,
  cookies: /\bchrome\.cookies\./,
  activeTab: /\bchrome\.activeTab\b/,
  tabs: /\bchrome\.tabs\./,
  clipboardWrite: /navigator\.clipboard\.write/,
  offscreen: /\bchrome\.offscreen\./,
  identity: /\bchrome\.identity\./,
  geolocation: /\bgeolocation\b/,
};

const manifest = JSON.parse(read("src/manifest.json"));
const declared = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];

for (const perm of declared) {
  const probe = PERMISSION_API[perm];
  if (!probe) {
    warnings.push(
      `permiso "${perm}" sin regla de uso en check-manifest.mjs: no se puede verificar si se usa. ` +
        `Añádelo a PERMISSION_API o quítalo del manifest.`
    );
    continue;
  }
  if (!probe.test(all)) {
    errors.push(
      `permiso "${perm}" declarado pero NO se usa en src/. ` +
        `Un permiso que no se usa infla la superficie declarada y lo marca la revisión de la tienda. ` +
        `Quítalo de src/manifest.json (si es de Firefox, bórralo también en scripts/build-firefox.mjs).`
    );
  }
}

// Un permiso usado y no declarado también es un fallo: la extensión fallaría en
// runtime por el permiso, no al instalar.
const KNOWN_USED = Object.keys(PERMISSION_API);
for (const perm of KNOWN_USED) {
  if (!declared.includes(perm)) continue; // opcional no concedido por defecto: OK
}

// --- 3 y 4: versión mínima real ------------------------------------------------

// Tabla de APIs que el codigo usa y la version de Chrome que las trae.
//
// ESTA TABLA ES LA DECLARACION. Si el codigo empieza a usar una API que no esta
// aqui, sale UN aviso agregado, no uno por API: un guard que dispara treinta
// lineas por algo esperado entrena a ignorar sus avisos, que es exactamente lo
// que este repositorio se~-marka en los comentarios sobre el lint y el escaner
// de secretos. Anadir una API moderna obliga a declarar su version; no hacerlo
// es un aviso, no un fallo, porque puede que no imponga nada (getURL,
// sendMessage, onMessage...).
const API_MIN_CHROME = {
  // Manifest V3.
  service_worker: 88,
  // Panel lateral.
  "chrome.sidePanel": 114,
  // Alias antiguo / nombre de Gecko. El codigo de la entrada del panel prueba
  // `chrome.sidebarAction` para no romper en navegadores que aun lo expone.
  "chrome.sidebarAction": 114,
  "chrome.action.setBadgeText": 88,
  "chrome.action.setBadgeBackgroundColor": 110,
  "chrome.action.setBadgeTextColor": 110,
  // Storage.
  "chrome.storage.local": 38,
  "chrome.storage.session": 102,
  "chrome.storage.onChanged": 5,
  // Descargas.
  "chrome.downloads.download": 33,
  "chrome.downloads.search": 22,
  "chrome.downloads.onChanged": 20,
  // Red.
  "chrome.webRequest.onBeforeRequest": 12,
  "chrome.webNavigation.onCommitted": 12,
  "chrome.webNavigation.getAllFrames": 22,
  "chrome.declarativeNetRequest.updateSessionRules": 101,
  // Runtime y pestanas.
  "chrome.runtime.onMessage": 20,
  "chrome.runtime.sendMessage": 20,
  "chrome.runtime.connectNative": 12,
  "chrome.runtime.getURL": 12,
  "chrome.runtime.onInstalled": 15,
  "chrome.runtime.id": 12,
  "chrome.runtime.lastError": 12,
  "chrome.tabs.TAB": 88,
  "chrome.tabs.query": 5,
  "chrome.tabs.get": 5,
  "chrome.tabs.create": 88,
  "chrome.tabs.sendMessage": 20,
  "chrome.tabs.onUpdated": 20,
  "chrome.tabs.onRemoved": 15,
  "chrome.tabs.onActivated": 20,
  "chrome.windows.create": 88,
  // Opcionales.
  "chrome.permissions.request": 11,
  "chrome.permissions.contains": 5,
  "chrome.cookies.getAll": 5,
  // Inyeccion.
  "chrome.scripting.executeScript": 88,
  // Gecko: solo afecta al paquete de Firefox, no al suelo de Chrome.
  "browser.sidebarAction.open": 57,
  // APIs de JavaScript que si imponen suelo.
  "URL.canParse": 120,
  "Object.groupBy": 117,
  "toSorted": 110,
  "replaceAll": 85,
  "crypto.randomUUID": 92,
  "AbortSignal.timeout": 103,
  "showModal": 37,
};

// APIs presentes literalmente en el codigo, para el aviso agregado.
const literalApiUse = new Set();
for (const s of sources) {
  for (const m of s.text.matchAll(/\b(?:chrome|browser)\.[a-zA-Z]+(?:\.[a-zA-Z]+)?/g)) {
    literalApiUse.add(m[0]);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const usedApis = [];
for (const [api, min] of Object.entries(API_MIN_CHROME)) {
  // Detector por palabra: `chrome.storage.local` no puede contar como
  // `chrome.storage.session`.
  if (!new RegExp(`\\b${escapeRe(api)}\\b`).test(all)) continue;
  usedApis.push({ api, min });
}

const knownNames = Object.keys(API_MIN_CHROME);
// Una API ya está cubierta si es exactamente una clave, si es un PREFIX de una
// clave (es el namespace: `chrome.runtime` está cubierto por
// `chrome.runtime.onMessage`), o si una clave es su prefijo (es un hijo:
// `chrome.tabs.sendMessage` está cubierto por la entrada del padre).
const isCovered = (used) =>
  knownNames.some((k) => k === used || k.startsWith(used + ".") || used.startsWith(k + "."));
const unknown = [...literalApiUse]
  .filter((used) => used.split(".").length >= 2)
  .filter((used) => !isCovered(used))
  .sort();
if (unknown.length) {
  warnings.push(
    `${unknown.length} API(s) en uso sin version declarada en API_MIN_CHROME: ${unknown.join(", ")}. ` +
      `Si alguna exige una version mas alta que minimum_chrome_version, declara su version en la tabla.`
  );
}

const required = usedApis.length ? Math.max(...usedApis.map((a) => a.min)) : 0;
const declaredMin = parseInt(manifest.minimum_chrome_version || "0", 10);
if (!declaredMin) {
  errors.push("src/manifest.json no declara `minimum_chrome_version`, y el código usa APIs que la necesitan.");
} else if (declaredMin < required) {
  errors.push(
    `minimum_chrome_version "${declaredMin}" es menor que lo que exige el código (${required}). ` +
      `APIs que lo imponen: ${usedApis
        .filter((a) => a.min === required)
        .map((a) => `${a.api} (${a.min})`)
        .join(", ")}`
  );
} else if (declaredMin > required) {
  notes.push(
    `minimum_chrome_version "${declaredMin}" es más alta que la exigida por las APIs (${required}). ` +
      `Si es intencionado (por soporte real, no por API), déjalo y anótalo aquí.`
  );
}

// --- 5: Firefox sin APIs de Chromium -------------------------------------------

// La comprobación del PAQUETE DE FIREFOX (permisos que Gecko no tiene,
// service_worker, browser_specific_settings) NO vive aquí: no se puede validar un
// artefacto sin haberlo construido, y hacerlo aquí haría que `npm test` dependiera
// de un build previo. Está en scripts/check-firefox-build.mjs, que se ejecuta
// después de `npm run build:firefox`.

// --- informe --------------------------------------------------------------------

if (notes.length) {
  console.log("Notas:");
  for (const n of notes) console.log(`  · ${n}`);
}
if (warnings.length) {
  console.log("Avisos:");
  for (const w of warnings) console.log(`  · ${w}`);
}
if (errors.length) {
  console.error("\nEl manifest no es coherente con el código:");
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
console.log(
  `Manifest coherente: ${declared.length} permisos declarados y usados, ` +
    `minimum_chrome_version=${declaredMin} (máximo exigido: ${required}).`
);
