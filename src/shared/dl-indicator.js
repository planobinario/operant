// dl-indicator.js — Indicador de descarga con máquina de estados de motion design.
// Compartido entre el overlay de página (content.js) y las cards del panel.
// Estados: idle → progress (real o indeterminado) → success/error → vuelta a idle.
//
// Especificación:
//  - Anillo de progreso SVG inline (circle + stroke-dasharray/dashoffset),
//    no conic-gradient: 28x28, trazo 2px, radio 12 (C=2π·12≈75.4), rotación
//    -90deg, dashoffset = C·(1-progreso), transition 200ms linear.
//  - Checkmark con animación de trazo (stroke-dasharray/offset), 350ms,
//    cubic-bezier(0.34,1.56,0.64,1) (back-out con overshoot).
//  - Error: anillo rojo + "!" con trazo, 1500ms antes de volver a idle.
//  - Vuelta a idle: si el cursor sigue encima, cross-fade check→icono; si no,
//    el contenedor se oculta (fade-out).
//  - will-change: stroke-dashoffset, opacity para repintado sin jank.

(function (global) {
  "use strict";

  const C = 2 * Math.PI * 12; // ≈ 75.4

  // Icono idle (20x20, trazo 1.5): flecha + bandeja.
  function idleIcon() {
    return (
      '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" focusable="false" aria-hidden="true">' +
      '<path d="M10 3.5v8.2" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M6.6 8.4 10 11.8l3.4-3.4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M4 13.2v1.6a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6v-1.6" stroke-width="1.5" stroke-linecap="round"/>' +
      "</svg>"
    );
  }

  // Anillo de progreso SVG: 28x28 (o 22x22 en variante sm).
  // Surco al 15% + trazo de progreso.
  function ringSVG(indeterminate, size = 28) {
    const r = size === 22 ? 9.5 : 12; // radio proporcional (margen 2px)
    const cc = 2 * Math.PI * r;
    return (
      '<svg class="nt-dl-ring" viewBox="0 0 ' + size + " " + size + '" width="' + size + '" height="' + size + '" focusable="false" aria-hidden="true">' +
      '<circle class="nt-dl-ring-track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="2"/>' +
      '<circle class="nt-dl-ring-bar" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="2"' +
      ' stroke-dasharray="' + cc + '" stroke-dashoffset="' + cc + '"' +
      (indeterminate ? ' data-indet="1"' : "") + "/>" +
      "</svg>"
    );
  }

  // Checkmark con trazo animable (path de 2 segmentos, viewBox 24).
  function checkSVG() {
    return (
      '<svg class="nt-dl-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" focusable="false" aria-hidden="true">' +
      '<path d="M6 12l4 4 8-10" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>"
    );
  }

  // "!" de error (trazo simple, viewBox 24).
  function errorSVG() {
    return (
      '<svg class="nt-dl-err" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" focusable="false" aria-hidden="true">' +
      '<path d="M12 5v8" stroke-width="2.5" stroke-linecap="round"/>' +
      '<circle cx="12" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>' +
      "</svg>"
    );
  }

  // CSS del indicador (se inyecta una vez por contexto). Colores vía CSS
  // variables con fallback: --nt-accent (morado), --nt-success (verde),
  // --nt-danger (rojo), --nt-text-secondary.
  function dlIndicatorCSS() {
    return `
    .nt-dl {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      color: var(--nt-text-secondary, #94a3b8);
    }
    /* Variante compacta (overlay de página): botón de 24px con anillo de 22px. */
    .nt-dl.nt-dl-sm {
      width: 24px;
      height: 24px;
    }
    .nt-dl.nt-dl-sm .nt-dl-ring {
      width: 22px;
      height: 22px;
    }
    .nt-dl.nt-dl-sm .nt-dl-idle svg {
      width: 18px;
      height: 18px;
    }
    .nt-dl .nt-dl-idle svg {
      display: block;
      width: 20px;
      height: 20px;
    }
    .nt-dl .nt-dl-stage,
    .nt-dl .nt-dl-check,
    .nt-dl .nt-dl-err {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nt-dl .nt-dl-ring {
      display: block;
    }
    .nt-dl .nt-dl-ring-track {
      stroke: var(--nt-accent, currentColor);
      stroke-opacity: 0.15;
    }
    .nt-dl .nt-dl-ring-bar {
      stroke: var(--nt-accent, currentColor);
      will-change: stroke-dashoffset;
    }
    .nt-dl .nt-dl-check {
      color: var(--nt-success, #22c55e);
      pointer-events: none;
      will-change: opacity;
    }
    .nt-dl .nt-dl-check path {
      will-change: stroke-dashoffset;
    }
    .nt-dl .nt-dl-err {
      color: var(--nt-danger, #ef4444);
      pointer-events: none;
      will-change: opacity;
    }
    .nt-dl.nt-dl-error .nt-dl-ring-bar,
    .nt-dl.nt-dl-error .nt-dl-ring-track {
      stroke: var(--nt-danger, #ef4444);
    }
    .nt-dl.nt-dl-error .nt-dl-ring-track {
      stroke-opacity: 0.15;
    }
    /* Indeterminado: el anillo rota completo (360deg en 1.2s, linear). */
    @keyframes nt-dl-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .nt-dl.nt-dl-progress .nt-dl-ring-bar[data-indet="1"] {
      transform-origin: 50% 50%;
    }
    `;
  }

  class DLIndicator {
    /**
     * @param {HTMLElement} host  elemento donde se monta (un <button> o contenedor).
     * @param {object} opts { size?: "sm"|"md" }
     */
    constructor(host, opts = {}) {
      this.host = host;
      this.state = "idle"; // idle | progress | success | error
      this.progress = 0; // 0..1
      this.indeterminate = false;
      this._timer = null;
      this._hovered = false;
      this._checkEl = null;
      this._errEl = null;
      this._ringBar = null;
      this._idleEl = null;

      host.classList.add("nt-dl");
      if (opts.size === "sm") host.classList.add("nt-dl-sm");
      host.setAttribute("aria-live", "polite");
      this._renderIdle();

      // Detección de hover para la vuelta a idle (estado 4).
      host.addEventListener("mouseenter", () => { this._hovered = true; });
      host.addEventListener("mouseleave", () => { this._hovered = false; });
    }

    _clear() {
      clearTimeout(this._timer);
      this._timer = null;
    }

    _renderIdle() {
      this.state = "idle";
      this.host.classList.remove("nt-dl-progress", "nt-dl-success", "nt-dl-error");
      this.host.innerHTML = "";
      this._idleEl = document.createElement("span");
      this._idleEl.className = "nt-dl-idle";
      this._idleEl.innerHTML = idleIcon();
      this.host.appendChild(this._idleEl);
    }

    /** Pasa a estado "progress". Si progress es null/undefined → indeterminado. */
    setProgress(p) {
      if (this.state === "success" || this.state === "error") return; // no retroceder
      this._clear();
      const indet = !(typeof p === "number" && isFinite(p));
      this.indeterminate = indet;
      this.progress = indet ? 0 : Math.max(0, Math.min(1, p));
      this.state = "progress";
      this.host.classList.add("nt-dl-progress");
      this.host.classList.remove("nt-dl-success", "nt-dl-error");
      // Re-render solo si no estamos ya en progress (evitar parpadeo del DOM).
      if (!this._ringBar) {
        this.host.innerHTML = "";
        const wrap = document.createElement("span");
        wrap.className = "nt-dl-stage";
        const size = this.host.classList.contains("nt-dl-sm") ? 22 : 28;
        wrap.innerHTML = ringSVG(indet, size);
        this.host.appendChild(wrap);
        this._ringBar = wrap.querySelector(".nt-dl-ring-bar");
        this._ringTrack = wrap.querySelector(".nt-dl-ring-track");
        this._ringC = 2 * Math.PI * (size === 22 ? 9.5 : 12);
        // Rotación inicial -90deg: el progreso empieza en las 12.
        this._ringBar.style.transformOrigin = "50% 50%";
        this._ringBar.style.rotate = "-90deg";
      }
      if (indet) {
        this._ringBar.style.transition = "none";
        this._ringBar.style.strokeDashoffset = String(this._ringC * 0.25); // 25% visible
        this._ringBar.style.animation = "nt-dl-spin 1.2s linear infinite";
      } else {
        this._ringBar.style.animation = "none";
        this._ringBar.style.transition = "stroke-dashoffset 200ms linear";
        this._ringBar.style.strokeDashoffset = String(this._ringC * (1 - this.progress));
      }
    }

    /** Completa con éxito: checkmark con animación de trazo (350ms back-out). */
    success() {
      this._clear();
      if (this.state === "progress" && this._ringBar) {
        // Completar el anillo (100%) antes del check.
        this._ringBar.style.animation = "none";
        this._ringBar.style.transition = "stroke-dashoffset 200ms linear";
        this._ringBar.style.strokeDashoffset = "0";
      }
      this.state = "success";
      this.host.classList.add("nt-dl-success");
      this.host.classList.remove("nt-dl-progress", "nt-dl-error");
      // Mantener el anillo completo visible; añadir el check DENTRO.
      if (!this._checkEl) {
        this._checkEl = document.createElement("span");
        this._checkEl.className = "nt-dl-check";
        this._checkEl.innerHTML = checkSVG();
        this.host.appendChild(this._checkEl);
        const path = this._checkEl.querySelector("path");
        const len = path.getTotalLength ? path.getTotalLength() : 24;
        path.style.strokeDasharray = String(len);
        path.style.strokeDashoffset = String(len);
        // Reflow + animación de trazo con overshoot.
        requestAnimationFrame(() => {
          path.style.transition = "stroke-dashoffset 350ms cubic-bezier(0.34, 1.56, 0.64, 1)";
          path.style.strokeDashoffset = "0";
        });
      }
      this._timer = setTimeout(() => this._afterDone(), 1200);
    }

    /** Error: anillo rojo + "!" (1500ms). */
    error() {
      this._clear();
      this.state = "error";
      this.host.classList.add("nt-dl-error");
      this.host.classList.remove("nt-dl-progress", "nt-dl-success");
      if (!this._ringBar) {
        this.host.innerHTML = "";
        const wrap = document.createElement("span");
        wrap.className = "nt-dl-stage";
        const size = this.host.classList.contains("nt-dl-sm") ? 22 : 28;
        wrap.innerHTML = ringSVG(false, size);
        this.host.appendChild(wrap);
        this._ringBar = wrap.querySelector(".nt-dl-ring-bar");
        this._ringTrack = wrap.querySelector(".nt-dl-ring-track");
        this._ringC = 2 * Math.PI * (size === 22 ? 9.5 : 12);
        this._ringBar.style.transformOrigin = "50% 50%";
        this._ringBar.style.rotate = "-90deg";
        this._ringBar.style.transition = "stroke-dashoffset 200ms linear";
        this._ringBar.style.strokeDashoffset = "0"; // anillo completo en rojo
      }
      if (!this._errEl) {
        this._errEl = document.createElement("span");
        this._errEl.className = "nt-dl-err";
        this._errEl.innerHTML = errorSVG();
        this.host.appendChild(this._errEl);
      }
      this._timer = setTimeout(() => this._afterDone(), 1500);
    }

    _afterDone() {
      this._clear();
      // Estado 4: si el cursor sigue encima, volver a idle (cross-fade);
      // si no, el host se oculta (el llamador decide el fade-out).
      if (this._hovered || this.host.matches(":hover")) {
        this._backToIdle();
      } else {
        this.host.dispatchEvent(new CustomEvent("nt-dl-idle", { detail: { keepHover: false } }));
        // El llamador puede ocultar el contenedor; aquí volvemos a idle igualmente.
        this._renderIdle();
      }
    }

    _backToIdle() {
      // Cross-fade: check/error sale (250ms ease-out) y el icono idle entra.
      const cur = this._checkEl || this._errEl;
      if (cur) {
        cur.style.transition = "opacity 250ms ease-out";
        cur.style.opacity = "0";
        setTimeout(() => cur.remove(), 260);
      }
      if (this._ringBar) {
        this._ringBar.style.transition = "opacity 250ms ease-out";
        this._ringBar.style.opacity = "0";
        const track = this._ringTrack;
        if (track) { track.style.transition = "opacity 250ms ease-out"; track.style.opacity = "0"; }
        setTimeout(() => {
          if (this._ringBar) this._ringBar.remove();
          if (this._ringTrack) this._ringTrack.remove();
          this._ringBar = null;
          this._ringTrack = null;
        }, 260);
      }
      // El icono idle entra con fade-in simultáneo.
      const idle = document.createElement("span");
      idle.className = "nt-dl-idle";
      idle.innerHTML = idleIcon();
      idle.style.opacity = "0";
      idle.style.transition = "opacity 250ms ease-out";
      this.host.appendChild(idle);
      requestAnimationFrame(() => { idle.style.opacity = "1"; });
      this._idleEl = idle;
      this._checkEl = null;
      this._errEl = null;
      this.state = "idle";
      this.host.classList.remove("nt-dl-progress", "nt-dl-success", "nt-dl-error");
      this.host.dispatchEvent(new CustomEvent("nt-dl-idle", { detail: { keepHover: true } }));
    }

    /** Fuerza volver a reposo (p.ej. al re-hover). */
    reset() {
      this._clear();
      this._renderIdle();
    }

    /** Destruye timers/estado. */
    destroy() {
      this._clear();
    }
  }

  global.NTDLIndicator = DLIndicator;
  global.NTDLIndicatorCSS = dlIndicatorCSS;
})(typeof globalThis !== "undefined" ? globalThis : this);
