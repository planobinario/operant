// src/panel/theme-boot.js — Aplica el tema ANTES del primer pintado.
//
// Extracción de un <script> inline que estaba en panel.html. El motivo no es
// estético: la CSP por defecto de MV3 prohíbe el script inline, y addons-linter
// lo marca (INLINE_SCRIPT). Un tema aplicado tarde produce un destello de color
// al abrir el panel, así que este script sigue siendo síncrono y en <head>:
// solo cambia que ya no viola la política de seguridad.
(() => {
  try {
    const stored = localStorage.getItem("theme");
    const theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();
