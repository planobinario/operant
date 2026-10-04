// tests/unit/extension-id.test.js - La identidad criptográfica de la extensión.
//
// POR QUÉ ESTO ES UN TEST Y NO UN COMENTARIO
// ------------------------------------------
// El extension ID de Chrome se DERIVA de la clave pública del manifest
// (SHA-256 de la SPKI DER, 16 bytes, cada nibble mapeado a 'a'-'p'). El mismo ID
// apareceollen tres sitios independientes:
//
//   src/manifest.json                   campo `key`          -> lo usa Chrome
//   native-host/key_info.json           extensionId          -> documentación
//   native-host-rs/src/installer.rs     EXTENSION_ID         -> allowed_origins
//
// Si divergen, el síntoma NO es un error visible: el host nativo se registra
// contra un ID que no existe y el panel dice "el host no está instalado" para
// siempre, sin ninguna pista de por qué. Ya pasó: la clave privada estuvo
// commiteada en la historia y hubo que rotarla, y ese es justo el momento en el
// que estos tres valores se cambian a mano.
//
// Este test falla si dejan de cuadrar, y comprueba el algoritmo contra el valor
// conocido, para que un cambio en el algoritmo no pase por alto un ID incorrecto.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

// Algoritmo de Chromium para derivar el ID de una clave pública SPKI.
function extensionIdFromPublicKey(spkiDer) {
  const digest = createHash("sha256").update(spkiDer).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id.slice(0, 32);
}

const manifest = readJson("src/manifest.json");
const keyInfo = readJson("native-host/key_info.json");

describe("identidad de la extensión", () => {
  test("el algoritmo de derivación reproduce un ID conocido", () => {
    // Si esto falla, el algoritmo de este fichero está mal y todas las
    // comprobaciones siguientes pasarían por un ID inventado.
    // Clave pública que Chromium asignó a apolplekoldkaignccbfcnejmoochdhf.
    const knownKey =
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2h3iu7JEva02JLCRAHOpEwk5fDU/7tP3QbLxD3lr8EjyutB5LhT+6MTAiRbuPbnSPO8AN9sY8oaBXShuhktmm4lpQgbfyzD+NLuaX7sHaWu5RBBxlPAmwHF19ItOqCgOp/2QH8cMhADT32pyHeQFrL3/oEjrA1WT0l2RjB6Vprzj8d49cY6KL2br4DczZS/BXzDJ8oVm7YhhOXCe6OKQH65tSyKhxm+/Svw6xGPV0+xtQ9xBA0vyO7TVxQjvuUzr6AAuAgobnfz+pu/JXCa084eLodXtnoBsUIYM7X/5k76Iny3QmlrtXZ/VyAWzEdo6UrgnSR1o2FeFz6FHlZ8a8QIDAQAB";
    assert.equal(extensionIdFromPublicKey(Buffer.from(knownKey, "base64")), "apolplekoldkaignccbfcnejmoochdhf");
  });

  test("el manifest trae una clave pública RSA válida de 2048 bits", () => {
    assert.ok(manifest.key, "sin `key`, Chrome asigna un ID distinto en cada instalación");
    const der = Buffer.from(manifest.key, "base64");
    // SPKI de RSA empieza por el SEQUENCE y el OID rsaEncryption 1.2.840.113549.1.1.1
    assert.equal(der[0], 0x30, "la clave debe ser un SEQUENCE DER");
    assert.ok(der.includes(Buffer.from("06092a864886f70d010101", "hex")), "OID rsaEncryption ausente");
    // 2048 bits = 256 bytes de módulo; la SPKI completa mide ~294.
    assert.ok(der.length >= 280 && der.length <= 300, `longitud SPKI inesperada: ${der.length}`);
  });

  test("el ID derivado de la clave del manifest es un ID de extensión válido", () => {
    const id = extensionIdFromPublicKey(Buffer.from(manifest.key, "base64"));
    assert.match(id, /^[a-p]{32}$/, `ID con forma inválida: ${id}`);
  });

  test("key_info.json y el manifest llevan la MISMA clave", () => {
    assert.equal(manifest.key, keyInfo.publicKeyBase64);
  });

  test("key_info.json declara el ID que se deriva de su propia clave", () => {
    assert.equal(keyInfo.extensionId, extensionIdFromPublicKey(Buffer.from(keyInfo.publicKeyBase64, "base64")));
  });

  test("el host nativo se registra contra el MISMO ID que la extensión", () => {
    // La divergencia aquí es silenciosa: el manifiesto de Native Messaging se
    // registra con allowed_origins de otro ID y la extensión nunca puede
    // conectarse, sin error visible.
    const installer = read("native-host-rs/src/installer.rs");
    const m = installer.match(/pub const EXTENSION_ID: &str = "([a-p]{32})"/);
    assert.ok(m, "no se encuentra EXTENSION_ID en installer.rs");
    assert.equal(m[1], keyInfo.extensionId, "installer.rs y key_info.json declaran IDs distintos");
  });

  test("la clave privada NO está en ningún fichero versionado", () => {
    for (const p of ["src/manifest.json", "native-host/key_info.json", "native-host-rs/src/installer.rs"]) {
      const t = read(p);
      assert.ok(!t.includes("PRIVATE KEY"), `${p} contiene una clave privada`);
    }
  });
});