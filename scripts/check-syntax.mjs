// scripts/check-syntax.mjs — Puerta de sintaxis para todo el JavaScript.
//
// Por qué existe: el repositorio no tenía NINGÚN linter ni formateador, y un
// error de sintaxis en `background.js` o `panel.js` no se descubre hasta que la
// extensión falla en el navegador. Aquí se parsea cada fichero con acorn (que
// ya estaba en el árbol como dependencia transitiva, y ahora se declara
// explícitamente) y se falla con código distinto de 0.
//
// Se prueban los DOS modos porque el repositorio mezcla:
//   · módulos ES (background.js, panel.js, shared/*.js, scripts/*.mjs)
//   · scripts clásicos (content.js, recorder-main.js, shared/icons.js,
//     dl-indicator.js, tests/*.js) — que NO admiten `import`/`export`.
//
// Uso:  node scripts/check-syntax.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Parser } from "acorn";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = ["src", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", "target", ".chrome", "results", "vendor", ".git", "fixtures"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if ([".js", ".mjs"].includes(extname(name))) out.push(full);
  }
  return out;
}

// Un fichero es "módulo" si su texto usa sintaxis ESM. Se detecta antes de
// parsear para no reportar como error un `export` que es perfectly válido.
function looksLikeModule(src) {
  return /^\s*(import\s|export\s|export\{|import\{)/m.test(src);
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
let failed = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const asModule = extname(file) === ".mjs" || looksLikeModule(src);
  try {
    Parser.parse(src, {
      ecmaVersion: "latest",
      sourceType: asModule ? "module" : "script",
      locations: true,
    });
  } catch (e) {
    failed++;
    console.error(`\nSYNTAX ERROR  ${rel}`);
    console.error(`  ${e.message}`);
    if (e.loc) {
      const lines = src.split("\n");
      const start = Math.max(0, e.loc.line - 4);
      const end = Math.min(lines.length, e.loc.line + 3);
      for (let i = start; i < end; i++) {
        const mark = i + 1 === e.loc.line ? " >>>" : "    ";
        console.error(`${mark}${String(i + 1).padStart(5)}: ${lines[i]}`);
      }
    }
  }
}

console.log(
  failed
    ? `\n${failed} fichero(s) con errores de sintaxis de ${files.length}.`
    : `Sintaxis OK: ${files.length} ficheros JavaScript analizados.`
);
process.exit(failed ? 1 : 0);
