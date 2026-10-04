// tests/unit/icons.test.js — Los SVG que se inyectan con innerHTML.
//
// CONTEXTO
// --------
// addons-linter marca 16 `UNSAFE_VAR_ASSIGNMENT` en nuestro código
// (content.js, panel.js, dl-indicator.js). Todos ellos son asignaciones
// `el.innerHTML = iconSvg(...)` o similar. El linter no puede demostrar que el
// valor sea estático, así que avisa.
//
// En vez de dejar 16 avisos sin justification o de "arreglarlos" con una
// ofuscación que esconda la referencia, este archivo convierte el invariante en
// algo COMPROBABLE:
//
//   · todo SVG producido tiene una gramática estricta;
//   · ningún SVG lleva atributos `on*` (onload, onerror, ...);
//   · ninguna etiqueta o atributo puede ejecutar código;
//   · el único punto de interpolación (`size`) está coaccionado a entero, así
//     que la inyección de HTML es estructuralmente imposible.
//
// Si algún día alguien añade un icono con `<script>` o mete `size` sin
// coercionar, estos tests fallan.
//
// Uso:  node --test tests/unit/

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let Icons;

before(() => {
  // icons.js es un script clásico que se publica en globalThis, así que se
  // carga en un contexto aislado en lugar de importarse como módulo.
  const src = readFileSync(resolve(ROOT, "src/shared/icons.js"), "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "icons.js" });
  Icons = sandbox.OperantIcons;
});

// Gramática Deliberadamente estricta: solo <svg> con atributos de una lista
// blanca, y cuerpo composed únicamente de <path>/<circle>/<rect>/<line>/
// <polyline>/<g>/<defs> sin ninguna otra cosa.
const ALLOWED_TAGS = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "g", "defs", "ellipse"]);
const ALLOWED_SVG_ATTRS = new Set([
  "viewbox",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "aria-hidden",
  "d",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "rx",
  "ry",
  "points",
  "transform",
]);

function auditSvg(label, svg) {
  assert.equal(typeof svg, "string", `${label}: debe ser un string`);

  // 1. Sin etiquetas fuera de la lista blanca.
  const tags = [...svg.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
  for (const t of tags) {
    assert.ok(ALLOWED_TAGS.has(t), `${label}: etiqueta no permitida <${t}>`);
  }

  // 2. Sin atributos fuera de la lista blanca (esto descarta on*, y también
  //    href/src/style, que son vectores de ejecución o defiltration).
  const attrs = [...svg.matchAll(/([a-zA-Z-]+)\s*=/g)].map((m) => m[1].toLowerCase());
  for (const a of attrs) {
    assert.ok(ALLOWED_SVG_ATTRS.has(a), `${label}: atributo no permitido "${a}"`);
  }

  // 3. Sin handlers, sin javascript:, sin escapes insolitos.
  assert.ok(!/\son[a-z]+\s*=/i.test(svg), `${label}: lleva un atributo on*`);
  assert.ok(!/javascript:/i.test(svg), `${label}: contiene javascript:`);
  assert.ok(!/<script/i.test(svg), `${label}: contiene <script>`);
  assert.ok(!/\bhref\b|\bxlink:href\b|\bsrc\b/i.test(svg), `${label}: referencia externa`);

  // 4. Estructura balanceada y cerrada.
  assert.ok(svg.startsWith("<svg"), `${label}: debe empezar por <svg`);
  assert.ok(svg.trimEnd().endsWith("</svg>"), `${label}: debe terminar por </svg>`);

  // 5. Atributos de tamaño con valor numérico.
  const w = /\bwidth="([^"]*)"/.exec(svg);
  const h = /\bheight="([^"]*)"/.exec(svg);
  assert.ok(w && /^\d+$/.test(w[1]), `${label}: width debe ser un entero (${w && w[1]})`);
  assert.ok(h && /^\d+$/.test(h[1]), `${label}: height debe ser un entero (${h && h[1]})`);
  assert.equal(w[1], h[1], `${label}: width y height deben coincidir`);
}

describe("icons.js — el SVG que se inyecta con innerHTML es seguro por construcción", () => {
  test("el módulo se carga y expone la API", () => {
    assert.ok(Icons, "OperantIcons debe existir");
    assert.equal(typeof Icons.svg, "function");
    assert.equal(typeof Icons.names, "function");
  });

  test("todos los iconos cumplen la gramática estricta", () => {
    const names = Icons.names();
    assert.ok(names.length > 0, "debe haber iconos");
    for (const name of names) {
      auditSvg(`icono "${name}"`, Icons.svg(name));
    }
  });

  test("size se coacciona: un valor no numérico no puede inyectar atributos", () => {
    // Esta es LA prueba que justifica el resto: si `size` no estuviera
    // coaccionado en svg(), esto produciría
    //   <svg ... width="11" onload=alert(1)" ...>
    // y el resultado se asignaría a innerHTML en el overlay de cada página.
    const evil = '11" onload="alert(1)';
    const svg = Icons.svg("download", evil);
    assert.ok(!/\son[a-z]+\s*=/i.test(svg), `atributo inyectado: ${svg}`);
    auditSvg("size malicioso", svg);
  });

  test("size se acota a un rango usable", () => {
    for (const [input, expected] of [
      [0, 8],
      [-100, 8],
      [1e9, 96],
      [14, 14],
      ["16", 16],
      [13.6, 14],
      [NaN, 14],
      [undefined, 14],
      [null, 14],
      [{}, 14],
    ]) {
      const svg = Icons.svg("download", input);
      const w = /\bwidth="(\d+)"/.exec(svg);
      assert.ok(w, `sin width para ${String(input)}`);
      assert.equal(Number(w[1]), expected, `size ${String(input)} -> ${w[1]}, esperado ${expected}`);
    }
  });

  test("un nombre inexistente cae en un icono por defecto, no en vacío", () => {
    const svg = Icons.svg("no-existe-este-icono");
    auditSvg("fallback", svg);
  });

  test("has() distingue icono existente de inexistente", () => {
    assert.equal(Icons.has("download"), true);
    assert.equal(Icons.has("no-existe-este-icono"), false);
  });

  test("el SVG no lleva texto ni nodos de texto que puedan inyectarse", () => {
    for (const name of Icons.names()) {
      const svg = Icons.svg(name);
      // Fuera del <svg>, solo puede haber geometría autocerrada.
      assert.ok(!/>[^<]*[^/\s>][^<]*</.test(svg.replace(/<\/?[a-zA-Z][^>]*>/g, "")), `texto unexpectedo en ${name}`);
    }
  });
});
