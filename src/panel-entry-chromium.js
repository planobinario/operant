// src/panel-entry-chromium.js — Punto de entrada del panel lateral en Chromium.
//
// Se declara en un fichero PROPIO, y no dentro de background.js, por una razón
// concreta: `chrome.sidePanel` es una API exclusiva de Chromium y
// addons-linter marca cualquier referencia a ella con UNSUPPORTED_API al
// validar el paquete de Firefox. Con la detección de funciones dentro de
// background.js, el aviso era inevitable... y el workaround "correcto" era
// oculta la referencia, lo que es peor que el aviso.
//
// En su lugar, la Build de Firefox sustituye este fichero por
// `panel-entry-gecko.js` (ver scripts/build-firefox.mjs), de modo que el
// paquete de Firefox no contiene NI UNA referencia a sidePanel, la
// functionality sigue siendo correcta en ambos navegadores, y el linter puede
// seguir diciendo la verdad.
//
// Contrato: `setupPanelOnInstalled()` se llama una vez, desde
// chrome.runtime.onInstalled.

export function setupPanelOnInstalled() {
  if (!chrome.sidePanel || typeof chrome.sidePanel.setPanelBehavior !== "function") {
    console.error(
      "[operant-sw] Este navegador no expone chrome.sidePanel: el icono de la barra no abrirá el panel."
    );
    return "none";
  }
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("[operant-sw] sidePanel.setPanelBehavior:", String(e?.message || e)));
  return "sidePanel";
}
