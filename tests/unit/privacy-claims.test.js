// tests/unit/privacy-claims.test.js - PRIVACY.md no puede convertirse en ficción.
//
// POR QUÉ
// -------
// Una política de privacidad es una afirmación legal. Si el código cambia y el
// documento no, el documento miente y eso tiene consecuencias. Este test ata las
// afirmaciones verificables del documento al código: si alguien introduce
// telemetría, o el host empieza a leer el perfil del navegador, o aparece un
// destino de red sin documentar, la CI se pone roja.
//
// La primera versión de este test buscaba "cualquier https:// en el código" y
// fallaba con una montaña de falsos positivos: los detectores de embeds
// contienen URLs de YouTube, Vimeo y Dailymotion que nunca se piden. La
// versión vigente usa señales precisas: un literal dentro de fetch(), una
// constante de URL en el host, o una URL de búsqueda inversa.
//
// LO QUE NO SE COMPRUEBA AQUÍ
// ---------------------------
//   · Que el texto sea completo o legal. Eso lo revisa una persona.
//   · Que no haya salidas de datos por una via que este analisis estatico no ve.
//     Eso es limitación honesta del método, no una garantía.
//
// La lista de permisos tiene que coincidir con la tabla de PRIVACY.md §3.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const js = [];
function collect(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "vendor") continue; // código de terceros
      collect(full);
    } else if (entry.endsWith(".js")) js.push(readFileSync(full, "utf8"));
  }
}
collect(resolve(ROOT, "src"));
const JS = js.join("\n");

const RUST_FILES = existsSync(resolve(ROOT, "native-host-rs/src"))
  ? readdirSync(resolve(ROOT, "native-host-rs/src")).filter((f) => f.endsWith(".rs"))
  : [];

// Solo el código de PRODUCCIÓN. Los bloques `#[cfg(test)]` se cortan porque
// contienen URLs de mentira ("https://cdn.e.com", "https://x/y") que no son
// destinos: son fixtures de test.
//
// El corte es "hasta el primer `#[cfg(test)]` de cada fichero", que es como está
// organizado el código (los tests van al final). Si algún día un fichero tuviera
// código de producción DESPUÉS de sus tests, este extractor lo ignoraría y el
// test seguiría pasando: es una limitación conocida, no una garantía.
const RS = RUST_FILES.map((f) => {
  const text = readFileSync(resolve(ROOT, "native-host-rs/src", f), "utf8");
  const cut = text.indexOf("#[cfg(test)]");
  return cut === -1 ? text : text.slice(0, cut);
}).join("\n");

const ALL = JS + "\n" + RS;
const manifest = JSON.parse(read("src/manifest.json"));

describe("PRIVACY.md 1 - no se recoge ni se transmite nada", () => {
  test("no hay telemetria, analitica ni crash reporting", () => {
    // Por nombres, no por dominios: lo que hay que cazar es una dependencia
    // NUEVA de un SDK de analitica, y eso casi siempre llega con uno de estos.
    const forbidden = [
      "google-analytics",
      "googletagmanager",
      "gtag(",
      "gtag.js",
      "mixpanel",
      "amplitude",
      "sentry",
      "bugsnag",
      "datadog",
      "segment.io",
      "segment.com",
      "posthog",
      "plausible.io",
      "matomo",
      "telemetry",
      "sendBeacon",
      "crashReporter",
      "crash_reporter",
      "webVitals",
    ];
    for (const token of forbidden) {
      assert.ok(
        !ALL.includes(token),
        `aparece "${token}" en el codigo: eso es telemetria y PRIVACY.md 1 afirma que no hay`
      );
    }
  });

  test("no hay destinos de red sin documentar", () => {
    const destinos = new Set();
    // A) fetch("https://host literal): senal directa de una peticion.
    for (const m of JS.matchAll(/fetch\(\s*["'`](https?:\/\/[a-z0-9.-]+)/gi)) {
      destinos.add(m[1].replace(/^https?:\/\//i, "").toLowerCase());
    }
    // B) Constantes de URL en el host nativo (descarga de herramientas).
    for (const m of RS.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      destinos.add(m[1].toLowerCase());
    }
    // C) Busqueda inversa: al pulsar un boton se envia la URL de la imagen a un
    //    tercero. Divulgan contenido del usuario, asi que tambien cuentan.
    for (const m of JS.matchAll(/https:\/\/([a-z0-9.-]+)\/(?:uploadbyurl|images\/search|search\.php|\?url=)/gi)) {
      destinos.add(m[1].toLowerCase());
    }

    // Documentados en PRIVACY.md 4 y 5. Anadir un destino obliga a documentarlo
    // aqui y en el documento.
    const DOCUMENTADOS = new Set([
      "github.com", // yt-dlp, a peticion
      "www.gyan.dev", // ffmpeg, a peticion
      "litterbox.catbox.moe", // subida temporal para buscar, con confirmacion
      "lens.google.com",
      "yandex.com",
      "saucenao.com",
      "tineye.com",
      "iqdb.org",
      "trace.moe",
    ]);
    const inesperados = [...destinos].filter((h) => !DOCUMENTADOS.has(h)).sort();
    assert.deepEqual(
      inesperados,
      [],
      `destinos de red no documentados en PRIVACY.md: ${inesperados.join(", ")}`
    );
    // Y que la lista documentada exista de verdad: si el test pasara porque el
    // codigo no tiene destinos, el extractor estaria roto y no comprobaria nada.
    assert.ok(destinos.size > 0, "no se ha detectado ningun destino: el extractor esta roto");
  });

  test("la busqueda inversa pide confirmacion antes de subir", () => {
    // Es el unico punto donde el contenido del usuario sale a un tercero. Si
    // desapareciera el texto de confirmacion, el usuario dejaria de saber que
    // su imagen se sube.
    assert.ok(
      /uploadBtn|Subir y buscar|Continuar\?/.test(JS),
      "no se encuentra la confirmacion previa a la subida"
    );
  });
});

describe("PRIVACY.md 5 - el host no toca tu perfil del navegador", () => {
  test("no se referencian ficheros de perfil de ningun navegador", () => {
    const forbidden = [
      "Login Data",
      "Web Data",
      "Cookies",
      "History",
      "Bookmarks",
      "profiles.ini",
      "Local State",
      "\\Google\\Chrome\\User Data",
      "\\Microsoft\\Edge\\User Data",
      "AppData\\Local\\Google\\Chrome",
    ];
    for (const token of forbidden) {
      assert.ok(
        !RS.includes(token),
        `el host referencia "${token}": el documento afirma que no lee el perfil del navegador`
      );
    }
  });

  test("no se invoca a nada que extraiga credenciales", () => {
    for (const token of ["--cookies-from-browser", "--load-info-json", "extract_cookies", "cookiejar"]) {
      assert.ok(!RS.includes(token), `el host usa "${token}"`);
    }
  });
});

describe("PRIVACY.md 3 - la tabla de permisos es la real", () => {
  const DECLARADOS = [
    "storage",
    "sidePanel",
    "downloads",
    "webRequest",
    "webNavigation",
    "nativeMessaging",
    "declarativeNetRequest",
    "scripting",
  ];
  const OPCIONALES = ["cookies"];

  test("los permisos del manifest son exactamente los documentados", () => {
    assert.deepEqual([...(manifest.permissions || [])].sort(), [...DECLARADOS].sort());
    assert.deepEqual([...(manifest.optional_permissions || [])].sort(), [...OPCIONALES].sort());
  });

  test("activeTab no esta", () => {
    assert.ok(!(manifest.permissions || []).includes("activeTab"), "activeTab volvio al manifest");
    assert.ok(!(manifest.optional_permissions || []).includes("activeTab"));
  });

  test("no hay permisos escondidos", () => {
    const todos = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
    const conocidos = new Set([...DECLARADOS, ...OPCIONALES, "activeTab"]);
    const extras = todos.filter((p) => !conocidos.has(p));
    assert.deepEqual(extras, [], `permisos no documentados en PRIVACY.md 3: ${extras.join(", ")}`);
  });

  test("no hay web_accessible_resources que hagan rastreable la extension", () => {
    assert.equal(
      manifest.web_accessible_resources,
      undefined,
      "web_accessible_resources hace la extension rastreable por cualquier pagina"
    );
  });

  test("no hay permisos de historial ni de gestion del navegador", () => {
    for (const p of ["history", "bookmarks", "management", "debugger", "privacy"]) {
      assert.ok(!(manifest.permissions || []).includes(p), `permiso inesperado: ${p}`);
    }
  });
});

describe("PRIVACY.md 2 - los datos guardados son los documentados", () => {
  test("solo se escribe en las claves de almacenamiento documentadas", () => {
    const claves = new Set();
    for (const m of JS.matchAll(/storage\.local\.set\(\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      claves.add(m[1]);
    }
    const DOCUMENTADAS = new Set([
      "autoDetect",
      "dlConcurrency",
      "history",
      "nativeStatus",
      "overlayEnabled",
      "overlayIgnoreSvg",
      "overlayMinSize",
      "selUrls",
      "theme",
      "viewPrefs",
    ]);
    const extra = [...claves].filter((k) => !DOCUMENTADAS.has(k));
    assert.deepEqual(extra, [], `claves de storage.local no documentadas en PRIVACY.md 2: ${extra.join(", ")}`);
  });

  test("el historial esta acotado", () => {
    // Sin tope, `history` es un vector de crecimiento en el perfil del usuario.
    assert.ok(/HISTORY_MAX|slice\(0,\s*\d+\)/.test(JS), "el historial no parece estar acotado");
  });
});
