// build-firefox.mjs — Genera dist-firefox/ desde src/ con el manifest
// parcheado al formato de Gecko: Chrome MV3 exige background.service_worker
// y rechaza background.scripts; Firefox MV3 exige background.scripts y no
// soporta service_worker. Un solo árbol de fuentes, dos targets.
import { cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
manifest.background = {
  scripts: [manifest.background.service_worker],
  ...(manifest.background.type ? { type: manifest.background.type } : {}),
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("dist-firefox/ generado (background.scripts para Gecko).");
