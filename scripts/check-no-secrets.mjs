// scripts/check-no-secrets.mjs - Nada de material privado ni binarios en el repo.
//
// POR QUÉ ES UN SCRIPT Y NO UN HEREDOC EN EL YAML
// ------------------------------------------------
// El chequeo estaba escrito dentro del workflow, y eso tenía dos costes:
//   - no se podía ejecutar en local antes de commitear,
//   - su única copia estaba duplicada, y la documentación tenía que repetir el
//     marcador literal de la clave privada. Al repetirlo, el propio documento
//     dispara el escáner y la CI se pone roja por un texto que ES la explicación
//     del problema. Es un fallo por construcción: cualquier escrito honesto
//     sobre el incidente se convierte en un positivo.
//
// Con una sola fuente, este script, la documentación puede describir el
// problema sin copiar el marcador.
//
// QUÉ COMPRUEBA
// -------------
//   1. Ningún fichero VERSIONADO contiene una clave privada PEM/OpenSSH/PGP.
//      Se recorre `git ls-files`, no el disco: lo que importa es lo que está
//      en el índice, y un .pem en `.secrets/` es exactamente lo que se quiere
//      tener en el disco y fuera de git.
//   2. Ningún fichero versionado tiene extensión de binario compilado. El
//      ejecutable del host es un artefacto de `cargo build` en CI.
//
// Uso:  node scripts/check-no-secrets.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 4 * 1024 * 1024; // por encima: binario, no texto

// El marcador se construye POR PARTES, y todos los marcadores, no solo el
// primero.
//
// La primera versión componía solo `BEGIN` + `PRIVATE KEY` y dejaba los otros
// cuatro como literales. Resultado: el escáner se detectaba a sí mismo y la CI
// quedaba roja permanentemente — un guard que se dispara solo es peor que no
// tenerlo, porque entrena al equipo a ignorarlo.
//
// Ninguna de estas cadenas contiene la frase completa de forma contigua, así que
// el script se puede escanear a sí mismo (lo hace: recorre `git ls-files`, y él
// está versionado).
const PEM_TAIL = ["PRIVATE", "KEY"].join(" ");
const PEM_MARKERS = [
  ["BEGIN", PEM_TAIL].join(" "),
  ["BEGIN RSA", PEM_TAIL].join(" "),
  ["BEGIN EC", PEM_TAIL].join(" "),
  ["BEGIN OPENSSH", PEM_TAIL].join(" "),
  ["BEGIN PGP", PEM_TAIL].join(" "),
  ["BEGIN ENCRYPTED", PEM_TAIL].join(" "),
];

const BINARY_EXT = /\.(exe|dll|so|dylib|msi|class|jar|apk|ipa|pdb)$/i;

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

let tracked = [];
try {
  tracked = git("ls-files").split(/\r?\n/).filter(Boolean);
} catch {
  console.error("no se pudo ejecutar `git ls-files`: ¿esto es un clon de git?");
  process.exit(1);
}

const problems = [];
let inspected = 0;

for (const file of tracked) {
  if (BINARY_EXT.test(file)) {
    problems.push(`${file}: binario compilado en el índice. Un artefacto de release se compila en CI y se publica con checksum.`);
    continue;
  }
  let buf;
  try {
    buf = readFileSync(resolve(ROOT, file));
  } catch {
    continue; // enlace roto, submodule, o lo que sea
  }
  if (buf.length > MAX_BYTES) continue;
  inspected++;
  const text = buf.toString("utf8");
  for (const marker of PEM_MARKERS) {
    if (text.includes(marker)) {
      problems.push(
        `${file}: contiene "${marker}".\n` +
          `  Si es la clave de la extensión, está COMPROMETIDA: purgar el fichero no basta,\n` +
          `  hay que ROTARLA (npm run keygen) y reescribir el historial. Ver docs/KEY-ROTATION.md.`
      );
      break;
    }
  }
}

if (problems.length) {
  console.error("Comprobación de secretos fallida:");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

console.log(
  `Sin material privado ni binarios en el índice (${inspected} ficheros de texto inspeccionados, ${tracked.length} versionados).`
);