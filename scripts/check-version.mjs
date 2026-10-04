// scripts/check-version.mjs — Una sola versión, comprobada.
//
// Existían NUEVE sitios con CUATRO valores distintos para la versión:
//   package.json                       0.4.1
//   src/manifest.json                  0.4.1
//   package-lock.json                  0.4.0   <- nunca se actualizaba
//   native-host-rs/Cargo.toml          0.4.0
//   native-host-rs/src/main.rs         v0.4.0  (en --help)
//   native-host-rs/src/tools.rs        operant/0.4.0  (User-Agent)
//   native-host/operant_host.py        operant/0.4
//   web-ext-artifacts/*.zip            0.4.0
//   dist-firefox/manifest.json         0.4.0   <- build obsoleta
//
// `package.json` es la única fuente de verdad; el resto debe derivarse. Este
// script falla si algo se desvía, para que el error aparezca en la CI y no en
// una incidencia de tienda.
//
// Uso:  node scripts/check-version.mjs

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const errors = [];
const notes = [];

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  errors.push(`package.json version "${version}" no es semver estricto (x.y.z)`);
}

// --- manifest.json: debe coincidir exactamente ---
const manifest = JSON.parse(read("src/manifest.json"));
if (manifest.version !== version) {
  errors.push(`src/manifest.json version "${manifest.version}" != package.json "${version}"`);
}

// --- package-lock.json: se desincroniza solo al no usar npm version ---
const lock = JSON.parse(read("package-lock.json"));
const lockVersion = lock?.packages?.[""]?.version ?? lock?.version;
if (lockVersion !== version) {
  errors.push(`package-lock.json version "${lockVersion}" != package.json "${version}" (ejecuta \`npm install --package-lock-only\`)`);
}

// --- Cargo.toml ---
const cargo = read("native-host-rs/Cargo.toml");
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
if (cargoVersion !== version) {
  errors.push(`native-host-rs/Cargo.toml version "${cargoVersion}" != package.json "${version}"`);
}

// --- User-Agent del host: debe derivarse, no escrito a mano ---
const tools = read("native-host-rs/src/tools.rs");
const ua = /GH_UA:\s*&str\s*=\s*"operant\/([^"]+)"/.exec(tools)?.[1];
if (ua !== version) {
  errors.push(
    `native-host-rs/src/tools.rs User-Agent "operant/${ua}" != "${version}". ` +
      `Un User-Agent con la versión equivocada hace que las peticiones de actualización a GitHub se identifiquen mal.`
  );
}

// --- `--help` del host: también es un sitio donde se escribe a mano ---
//
// El comentario de cabecera de este script listaba `main.rs` como uno de los
// nueve sitios vigilados, pero no había ninguna comprobación para él: `v0.4.1`
// siguió ahí mientras el resto pasaba a 0.5.0, y el usuario que ejecutaba
// `--help` veía una versión que no correspondía al binario. La lista de la
// cabecera era una intención, no una garantía.
const main = read("native-host-rs/src/main.rs");
const mainVer = /Native Messaging Host v(\d+\.\d+\.\d+)/.exec(main)?.[1];
if (mainVer !== version) {
  errors.push(`native-host-rs/src/main.rs imprime "v${mainVer}" en --help != package.json "${version}"`);
}

// --- manifest.json necesita `key` (fija el ID de la extensión) ---
if (!manifest.key) {
  errors.push("src/manifest.json no tiene `key`: la extensión perdería su ID entre instalaciones");
}
if (/\.\.(?=\s*")/.test(JSON.stringify(manifest.permissions))) {
  notes.push("revisa los permisos declarados");
}

// --- El binario NO debe estar versionado ---
//
// `existsSync` no sirve: `npm run host:build` lo deja ahí a propósito en local,
// así que su presencia ya no significa nada. Lo que importa es si está en el
// ÍNDICE de git, que es lo que hace que forme parte del repositorio.
try {
  const tracked = execFileSync("git", ["ls-files", "--", "native-host"], { cwd: ROOT, encoding: "utf8" });
  const binaries = tracked.split(/\r?\n/).filter((f) => /\.(exe|dll|msi)$/i.test(f));
  if (binaries.length) {
    errors.push(
      `hay binarios compilados en el índice de git: ${binaries.join(", ")}. ` +
        `Un artefacto de release se compila en CI y se publica con checksum, no se versiona.`
    );
  }
} catch {
  notes.push("no se pudo consultar `git ls-files`: la comprobación de binarios versionados se ha omitido");
}

if (notes.length) {
  console.log("Avisos (no bloquean):");
  for (const n of notes) console.log(`  · ${n}`);
}

if (errors.length) {
  console.error(`\nVersionado incoherente (referencia: package.json = ${version}):`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}

console.log(`Versionado coherente: ${version}`);
