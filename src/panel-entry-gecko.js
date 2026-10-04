// src/panel-entry-gecko.js — Punto de entrada del panel lateral en Firefox/Gecko.
//
// Sustituye a `panel-entry-chromium.js` en la build de Firefox (ver
// scripts/build-firefox.mjs). En Gecko no existe `chrome.sidePanel`: la
// superficie equivalente es `browser.sidebarAction`.
//
// Diferencia de comportamiento que hay que respetar: en Chromium,
// `setPanelBehavior({openPanelOnActionClick:true})` hace que el icono de la
// barra abra el panel. En Firefox el "abrir al hacer clic" NO es automático,
// hay que pedirlo: se registra un listener en `sidebarAction.onClicked` que
// llama a `sidebarAction.open()`.
//
// Contrato: `setupPanelOnInstalled()` se llama una vez, desde
// chrome.runtime.onInstalled.

export function setupPanelOnInstalled() {
  const sidebar =
    (typeof browser !== "undefined" && browser && browser.sidebarAction) ||
    (chrome && chrome.sidebarAction) ||
    null;

  if (!sidebar || !sidebar.onClicked) {
    console.error(
      "[operant-sw] Firefox no expone sidebarAction: el icono de la barra no abrirá el panel."
    );
    return "none";
  }

  const open = () => {
    try {
      if (typeof sidebar.open === "function") {
        const r = sidebar.open();
        // En Firefox moderno `open()` devuelve una promesa que rechaza si el
        // usuario tiene la barra lateral cerrada: no es un error que merezca
        // ruido, pero sí hay que capturarla para no romper el listener.
        if (r && typeof r.catch === "function") r.catch(() => {});
      }
    } catch {
      /* la ventana del navegador aún no está lista */
    }
  };

  sidebar.onClicked.addListener(open);

  // Gecko expone `open_at_install` en el manifest, pero no todos los perfiles
  // lo respetan; abrir en la instalación hace que el panel aparezca al
  // instalar, que es lo que espera el usuario de un panel lateral.
  open();

  return "sidebarAction";
}
