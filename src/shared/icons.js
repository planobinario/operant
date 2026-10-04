// icons.js — Sistema de iconos normalizado de Operant (ÚNICA fuente de geometría).
// Especificación:
//   · Rejilla 24×24 (estándar Lucide) — se escala nítido a 11-16px.
//   · Trazo 1.75 uniforme en TODO el set · fill="none" · currentColor.
//   · Extremos y uniones redondeados (linecap/linejoin round).
//   · Un solo productor: overlay (content.js) y panel (panel.html/panel.js)
//     consumen el MISMO set — coherencia estética garantizada por diseño.
// Consumo: OperantIcons.svg(name, size) → string SVG listo para innerHTML.
(function (global) {
  "use strict";

  // Geometría (trazos interiores del <svg>; el envoltorio lo genera svg()).
  const P = {
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    external:
      '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    expand:
      '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    refresh:
      '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    reset:
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    music:
      '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    headphones:
      '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
    video:
      '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>',
    file:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    camera:
      '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    copy:
      '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    zoomIn:
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    zoomOut:
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><path d="M12 19h8"/>',
    record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    minus: '<path d="M5 12h14"/>',
  };

  // Genera el <svg> completo. size en px; stroke 1.75 fijo (norma del set).
  //
  // `size` se COACCIONA a un entero acotado antes de interpolarse. Es la única
  // interpolación del módulo, y el resultado se asigna a `innerHTML` en el
  // overlay y en el panel, así que sin esta coerción un valor no numérico
  // ("11\" onload=alert(1)") sería inyección de HTML. Con el `Number()` la
  // inyección es estructuralmente imposible, y no depende de que todos los
  // llamadores Recall pasar un número.
  //
  // Ver tests/unit/icons.test.js: comprueba que la salida de TODOS los iconos
  // cumple una gramática SVG estricta y no lleva atributos `on*`.
  const MIN_SIZE = 8;
  const MAX_SIZE = 96;

  function svg(name, size = 14) {
    const body = P[name] || P.file;
    // `null`, `undefined` y "" significan "sin tamaño indicado" → default.
    // Sin este caso, `Number(null)` es 0 y el icono saldría a 8 px (el mínimo),
    // que no es lo que quiere quien llama.
    const n = size === null || size === undefined || size === "" ? NaN : Number(size);
    const px = Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) : 14;
    return (
      `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor"` +
      ` stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
    );
  }

  const api = { svg, has: (name) => Object.prototype.hasOwnProperty.call(P, name), names: () => Object.keys(P) };
  global.OperantIcons = api;
  global.NTIcons = api; // alias de compatibilidad
})(typeof window !== "undefined" ? window : globalThis);
