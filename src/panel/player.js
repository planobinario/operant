const q = new URLSearchParams(location.search);
const src = q.get("src") || "";
const v = document.getElementById("v");
const err = document.getElementById("err");
const showErr = (m) => {
  err.textContent = m;
  err.style.display = "block";
};
document.title = q.get("name") || "Operant — Reproductor";

if (!src) {
  showErr("Sin fuente de vídeo (src vacío).");
} else if (/\.m3u8($|\?)/i.test(src) && window.Hls && Hls.isSupported()) {
  const hls = new Hls();
  hls.on(Hls.Events.ERROR, (_e, d) => {
    if (d.fatal) showErr("Error de stream: " + (d.details || "desconocido"));
  });
  hls.loadSource(src);
  hls.attachMedia(v);
} else if (/\.mpd($|\?)/i.test(src) && window.dashjs && dashjs.MediaPlayer) {
  dashjs.MediaPlayer().create().initialize(v, src, true);
} else {
  v.src = src;
}

v.play().catch(() => {});

// Pantalla completa nativa (en una ventana popup sí está disponible).
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => showErr("Pantalla completa no disponible aquí."));
  }
});
