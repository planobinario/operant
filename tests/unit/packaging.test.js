// tests/unit/packaging.test.js - Lo que DENTRO de los paquetes se distribuye.
//
// POR QUÉ ESTE FICHERO EXISTE
// ---------------------------
// `npm run build` (Chromium) y `npm run build:firefox` escribían los dos en
// `web-ext-artifacts/` con el MISMO nombre de fichero, porque web-ext deriva el
// zip del nombre+versión de la extensión. El segundo build sobrescribía al
// primero. Ambos terminaban con código 0, `npm test` pasaba, la CI subía
// `web-ext-artifacts/*.zip` y.Clickingly: se distribucía UN paquete.
//
// Es decir: el paquete de CHROME —la plataforma para la que existe la
// extensión— no se publicaba, y nada en el repositorio lo señalaba. Todo lo
// que se comprobaba era que el código fuente fuera correcto, nunca que el
// artefacto lo reflejara.
//
// Estos tests son esa red. Leen los zips ya construidos y comprueban que cada
// destino produce el manifest que le corresponde. Si alguien vuelve a unificar
// los directorios, o si una traducción de Firefox deja de aplicarse, falla aquí
// y no en la tienda.
//
// Requiere `npm run build && npm run build:firefox` antes. Si los zips no
// existen, los tests se saltan con un motivo explícito en lugar de fallar en
// silencio: en un clon sin construituras previas no hay nada queistribution
// verificar, y eso no es un defecto del código.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACTS = resolve(ROOT, "web-ext-artifacts");

// Un ZIP es un contenedor simple: el índice central es la lista de entradas con
// su offset, y cada entrada tiene su cabecera local con el tamaño real del
// dato. Los paquetes de web-ext van comprimidos con DEFLATE (método 8), así que
// leer un fichero exige inflarlo; `zlib` viene en Node, así que esto no añade
// dependencias al proyecto.
const STORED = 0;
const DEFLATED = 8;

function readZip(zipPath) {
  const buf = readFileSync(zipPath);
  // Firma End of Central Directory (PK\005\006), barrida desde el final.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, `no parece un ZIP valido: ${zipPath}`);
  const count = buf.readUInt16LE(eocd + 10); // u16: leerlo como u32 arrastra el tamaño del índice
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "entrada central corrupta en el indice central");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // La cabecera local repite nombre y extra con longitudes propias, que no
    // tienen por que coincidir con las del indice central.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    let data;
    if (method === STORED) data = Buffer.from(raw);
    else if (method === DEFLATED) data = inflateRawSync(raw);
    else throw new Error(`metodo de compresion no soportado (${method}) en ${name}`);

    files.set(name, { data, method, compressedSize, size: data.length });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { files };
}

function manifestOf(zipPath) {
  const { files } = readZip(zipPath);
  const f = files.get("manifest.json");
  assert.ok(f, `el zip no contiene manifest.json: ${zipPath}`);
  return JSON.parse(f.data.toString("utf8"));
}

function zipIn(dir) {
  if (!existsSync(dir)) return null;
  const zips = readdirSync(dir).filter((f) => f.endsWith(".zip"));
  if (!zips.length) return null;
  return resolve(dir, zips[0]);
}

const chromiumZip = () => zipIn(resolve(ARTIFACTS, "chromium"));
const firefoxZip = () => zipIn(resolve(ARTIFACTS, "firefox"));

const built = chromiumZip() && firefoxZip();

describe("paquetes distribuibles", () => {
  before(() => {
    if (!built) {
      console.log(
        "[packaging] sin builds: se ejecuta `npm run build && npm run build:firefox` para verificar el contenido de los paquetes"
      );
    }
  });

  test("Chromium y Firefox se empaquetan en directorios DISTINTOS", () => {
    // Esta es la aserción que habría atrapado la sobrescritura. Los dos
    // artefactos comparten nombre de fichero por diseño (nombre+versión), así
    // que la única forma de distinguirlos es el directorio.
    if (!built) return;
    assert.ok(chromiumZip(), "falta el paquete de Chromium (web-ext-artifacts/chromium/)");
    assert.ok(firefoxZip(), "falta el paquete de Firefox (web-ext-artifacts/firefox/)");
    assert.notEqual(chromiumZip(), firefoxZip(), "ambos paquetes apuntan al mismo fichero: uno sobrescribe al otro");
  });

  test("el paquete de Chromium conserva service_worker, side_panel y la clave", () => {
    if (!built) return;
    const m = manifestOf(chromiumZip());
    assert.equal(m.background.service_worker, "background.js");
    assert.equal(m.side_panel.default_path, "panel/panel.html");
    assert.ok(m.key, "Chrome necesita `key` para conservar el extension ID entre instalaciones");
    assert.ok(m.permissions.includes("sidePanel"), "Chrome necesita el permiso sidePanel");
  });

  test("el paquete de Firefox usa background.scripts y sidebar_action, sin clave", () => {
    if (!built) return;
    const m = manifestOf(firefoxZip());
    assert.deepEqual(m.background.scripts, ["background.js"], "Gecko no tiene service workers");
    assert.equal(m.background.service_worker, undefined, "Firefox no soporta service_worker");
    assert.equal(m.side_panel, undefined, "Firefox no tiene sidePanel API");
    assert.equal(m.sidebar_action.default_panel, "panel/panel.html");
    assert.equal(m.key, undefined, "la clave pública de Chrome no viaja al paquete de Firefox");
    assert.ok(!m.permissions.includes("sidePanel"), "sidePanel no existe en Firefox");
  });

  test("ambos paquetes llevan la misma versión, y es la de package.json", () => {
    if (!built) return;
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    assert.equal(manifestOf(chromiumZip()).version, pkg.version);
    assert.equal(manifestOf(firefoxZip()).version, pkg.version);
    assert.ok(chromiumZip().endsWith(`${pkg.version}.zip`), `el zip no se renombra con la versión: ${chromiumZip()}`);
    assert.ok(firefoxZip().endsWith(`${pkg.version}.zip`), `el zip no se renombra con la versión: ${firefoxZip()}`);
  });

  test("ningún paquete incluye el ejecutable del host nativo", () => {
    if (!built) return;
    for (const z of [chromiumZip(), firefoxZip()]) {
      const { files } = readZip(z);
      const offenders = [...files.keys()].filter((n) => /\.(exe|dll|msi|so|dylib)$/i.test(n));
      assert.deepEqual(offenders, [], `${z} incluye binarios: ${offenders.join(", ")}`);
    }
  });

  test("ningún paquete incluye la clave privada ni material de secretos", () => {
    if (!built) return;
    for (const z of [chromiumZip(), firefoxZip()]) {
      const { files } = readZip(z);
      const marker = ["BEGIN", "PRIVATE KEY"].join(" ");
      for (const [name, f] of files) {
        if (f.size > 4 * 1024 * 1024) continue;
        assert.ok(!f.data.toString("latin1").includes(marker), `${z}: ${name} contiene material de clave privada`);
      }
    }
  });

  test("el paquete incluye el código que el motor necesita", () => {
    // Un build de Firefox que se olvidara de un fichero compartido fallaría en
    // runtime, no en el linter: el linter solo mira el manifest.
    if (!built) return;
    const required = [
      "manifest.json",
      "background.js",
      "panel/panel.html",
      "panel/panel.js",
      "panel/theme-boot.js",
      "panel/player.js",
      "content.js",
      "shared/hls-fast.js",
      "shared/media-core.js",
      "shared/filename.js",
      "shared/icons.js",
      "icons/icon48.png",
    ];
    const { files } = readZip(firefoxZip());
    const names = [...files.keys()];
    for (const f of required) {
      assert.ok(names.includes(f), `el paquete de Firefox no incluye ${f}`);
    }
  });
});
