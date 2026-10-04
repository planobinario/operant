// scripts/gen-extension-key.mjs — Genera el par de claves de la extensión.
//
// POR QUÉ ESTE SCRIPT EXISTE
// -------------------------
// `src/manifest.json` incluye una clave pública RSA (`manifest.key`) que fija el
// ID de la extensión en Chrome. Eso es correcto y debe seguir commiteado. Lo
// que NO debe estar nunca en el repositorio es la clave PRIVADA correspondiente:
// con ella, cualquiera que la lea puede publicar una versión actualizada de la
// extensión instalada en el perfil de cualquier usuario (Chrome la acepta sin
// pedir permiso, porque la firma es válida).
//
// Uso:
//   node scripts/gen-extension-key.mjs            # genera y escribe ambos ficheros
//   node scripts/gen-extension-key.mjs --print    # solo muestra la clave pública
//
// Escribe:
//   native-host/key_info.json              (PÚBLICO, commiteado)  ← id + clave pública
//   native-host/.secrets/extension_key.pem (PRIVADO, gitignored) ← NUNCA commitear
//
// AL ROTAR LA CLAVE
// ------------------
// El ID de la extensión se DERIVA de la clave pública. Rotarla cambia el ID, y
// con él:
//   · el registro del host nativo (`operant_host_manifest.json` →
//     `allowed_origins`), que hay que volver a instalar con el ID nuevo;
//   · el enlace de descarga de la web de marketing;
//   · cualquier configuración guardada por los usuarios.
//
// Es un cambio que rompe instalaciones: hazlo con un.release mayor y en un
// commit propio, nunca mezclado con fixes.

import { generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_OUT = resolve(ROOT, "native-host/key_info.json");
const SECRET_DIR = resolve(ROOT, "native-host/.secrets");
const SECRET_OUT = resolve(SECRET_DIR, "extension_key.pem");
const PUBLIC_B64_OUT = resolve(SECRET_DIR, "extension_key.pub.b64");

function fail(msg) {
  console.error(`\n[gen-extension-key] ${msg}\n`);
  process.exit(1);
}

// El ID de la extensión es el SHA-256 de la clave pública SPKI (DER), con los
// primeros 16 bytes convertidos a letras 'a'-'p': es el algoritmo de Chromium.
// Verificado: este cálculo reproduce `apolplekoldkaignccbfcnejmoochdhf` a partir
// de la clave pública que había en el manifest, que es el ID que Chrome había
// asignado. `npm run test:unit` lo comprueba en cada commit.
function extensionIdFromPublicKey(spkiDer) {
  const digest = createHash("sha256").update(spkiDer).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id.slice(0, 32);
}

// `--verify`: comprueba que los tres sitios donde vive el ID concuerdan entre sí.
// El ID estaba hardcodeado en `installer.rs` y el host quedaba registrado contra
// un ID distinto del de la extensión instalada sin que nada lo dijera.
if (process.argv.includes("--verify")) {
  const info = JSON.parse(readFileSync(PUBLIC_OUT, "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "src/manifest.json"), "utf8"));
  const derived = extensionIdFromPublicKey(Buffer.from(info.publicKeyBase64, "base64"));
  const problems = [];
  if (manifest.key !== info.publicKeyBase64) {
    problems.push("src/manifest.json `key` != native-host/key_info.json `publicKeyBase64`");
  }
  if (derived !== info.extensionId) {
    problems.push(`key_info.extensionId "${info.extensionId}" != derivado "${derived}" de su propia clave pública`);
  }
  const installer = readFileSync(resolve(ROOT, "native-host-rs/src/installer.rs"), "utf8");
  const m = installer.match(/pub const EXTENSION_ID: &str = "([a-p]{32})"/);
  if (!m) problems.push("no se encuentra EXTENSION_ID en native-host-rs/src/installer.rs");
  else if (m[1] !== derived) {
    problems.push(`installer.rs EXTENSION_ID "${m[1]}" != "${derived}" (el host se registraría contra un ID que no existe)`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`::error:: ${p}`);
    process.exit(1);
  }
  console.log(`ID coherente en los tres sitios: ${derived}`);
  process.exit(0);
}

if (process.argv.includes("--print")) {
  console.log(
    "La clave pública vive en native-host/key_info.json y en src/manifest.json (campo `key`).\n" +
      "Para regenerarla ejecuta este script SIN --print.\n"
  );
  process.exit(0);
}

console.log("Generando par RSA 2048…");
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const publicKeyBase64 = publicKey.toString("base64");

mkdirSync(SECRET_DIR, { recursive: true });

// El ID de la extensión es el SHA-256 de la clave pública, con los primeros 16
// bytes convertidos a 'a'-'p' (el algoritmo de Chromium). Se calcula para poder
// mostrarlo y para verificar que coincide con el host ya registrado.
// El ID de la extensión es el SHA-256 de la clave publica SPKI, con los
// primeros 16 bytes convertidos a letras 'a'-'p' (algoritmo de Chromium).
const extensionId = extensionIdFromPublicKey(publicKey);

// 1. La clave PRIVADA, solo en disco y bajo un directorio gitignored.
writeFileSync(SECRET_OUT, privateKey, { encoding: "utf8", mode: 0o600 });
writeFileSync(PUBLIC_B64_OUT, publicKeyBase64 + "\n", "utf8");

// 2. El fichero PÚBLICO que sí se commitea.
writeFileSync(
  PUBLIC_OUT,
  JSON.stringify(
    {
      _commento:
        "SOLO datos públicos. La clave privada NUNCA va aquí: está en " +
        ".secrets/extension_key.pem (gitignored). Regenerar con " +
        "node scripts/gen-extension-key.mjs",
      extensionId,
      publicKeyBase64,
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`
Claves generadas.

  PRIVADA  ${SECRET_OUT}
           (gitignored — no la subas, no la compartas, no hagas copia en otro sitio)

  PÚBLICA  ${PUBLIC_OUT}
           commiteada; contiene extensionId + publicKeyBase64

  ID de extensión resultante: ${extensionId}

Ahora tienes que:
  1. Copiar publicKeyBase64 al campo "key" de src/manifest.json.
  2. Reinstalar el host nativo para que allowed_origins use el ID nuevo:
       native-host\\operant-host.exe install
  3. Revisar si enlazas al ID en la web de marketing o en la documentación.

AVISO: rotar la clave cambia el ID de la extensión y rompe las instalaciones
existentes (el host nativo quedaría registrado contra el ID antiguo).
`);
