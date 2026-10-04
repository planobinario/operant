// src/shared/filename.js — ÚNICA FUENTE DE VERDAD de nombres de archivo.
//
// Por qué existe este módulo: antes cada contexto derivaba el nombre por su
// cuenta (background.js `urlBasename`, panel.js `itemName`, y el basename que
// el host Rust deriva de la URL). Tres implementaciones, tres resultados, y
// ninguna era segura: `urlBasename()` hacía `split("/")` ANTES de
// `decodeURIComponent`, así que un separador percent-encoded (`%2F`) sobrevivía
// al nombre y una página podía pedir `a%2F..%2F..%2Fstartup.lnk` → descarga
// fuera del directorio esperado. Además no había saneo de caracteres ilegales,
// ni nombres reservados de Windows, ni normalización Unicode, ni límite de
// longitud, ni parseo de Content-Disposition.
//
// Reglas que garantiza `sanitizeFileName` (verificadas en tests/unit/filename.test.js):
//   1. Nunca contiene separadores de ruta (`/`, `\`), ni `..`, ni ruta absoluta.
//   2. Nunca contiene caracteres de control, ni bidireccionales (U+202E etc.),
//      ni de ancho cero: son la trampa clásica de suplantar `gpj.exe` como
//      `exe.jpg` en el explorador de archivos.
//   3. Nunca es un nombre reservado de Windows (CON, PRN, AUX, NUL, COM1-9,
//      LPT1-9) ni la forma `CON.png`, que sigue siendo inválida en Win32.
//   4. Unicode en forma NFC (evita que "é" selice en dos y rompa la dedup).
//   5. Longitud acotada por BYTES UTF-8, preservando la extensión.
//   6. Si tras todo queda vacío, devuelve un fallback estable (nunca "").
//
// Patrón de carga (idéntico a media-core.js / hls-fast.js): se publica en
// globalThis para los scripts clásicos (content scripts), y se exporta como
// ESM para los módulos (service worker, panel) y CommonJS para los tests.

// --- Longitud máxima por defecto. 255 es el límite de la mayoría de sistemas
// de ficheros, pero dejamos margen para que el nombre final + " (12)" + la
// carpeta de destino que Chrome antepone quepan en NTFS/ext4/APFS.
export const DEFAULT_MAX_BYTES = 180;

// Windows reserva estos nombres incluso con extensión (CON.png == CON).
// https://learn.microsoft.com/windows/win32/fileio/naming-a-file
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Caracteres de control (C0/C1) + separadores + los ilegales de Windows.
// Nota: la coma y el punto y coma SÍ son legales en Windows; no se tocan.
const ILLEGAL_CHARS =
  /[\u0000-\u001f\u007f-\u009f<>:"|?*\\/]/g;

// Controles bidireccionales y de ancho cero. No tienen función en un nombre de
// archivo y se usan para invertir visualmente la extensión.
const INVISIBLE_CHARS =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

const HAS_TEXT_ENCODER =
  typeof TextEncoder !== "undefined" && typeof TextEncoder.prototype.encode === "function";

export function utf8Length(str) {
  if (HAS_TEXT_ENCODER) return new TextEncoder().encode(str).length;
  // Fallback sin TextEncoder (entornos raros): cuenta UTF-16 code units, que
  // subestima el tamaño en UTF-8 pero nunca lo sobreestima.
  return str.length;
}

// Decodifica percent-encoding sin reventar con secuencias UTF-8 inválidas
// ( surrogates sueltos, %E0%A4%A malformado…). `decodeURIComponent` lanza
// URIError en esos casos y el fallback preserva el texto original.
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

// Quita controles invisibles y aplica NFC. Se hace ANTES de sustituir
// caracteres ilegales para que un `%E2%80%AE` (RLO) decodificado se elimine
// como lo que es, en lugar de convertirse en "_".
function normalize(raw) {
  let s = String(raw);
  s = s.replace(INVISIBLE_CHARS, "");
  if (typeof s.normalize === "function") {
    try {
      s = s.normalize("NFC");
    } catch {
      /* normalización no disponible: se deja tal cual */
    }
  }
  return s;
}

// Divide "base.ext" en [stem, ext] usando el ÚLTIMO punto que no sea inicial.
// "a.b.c" → ["a.b", ".c"]; ".hidden" → [".hidden", ""]; "sin" → ["sin", ""].
export function splitExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

// Recorta a `maxBytes` preservando la extensión. Si el stem no cabe entero, se
// le recorta (la extensión es lo que identifica el archivo para el usuario y
// para el mux posterior).
function truncateBytes(name, ext, maxBytes) {
  if (maxBytes <= 0) return "";
  let stem = name;
  if (utf8Length(name) <= maxBytes) return name;
  let extBudget = 0;
  if (ext) {
    const extBytes = utf8Length(ext);
    // Si la extensión sola ya no cabe, se descarta: es mejor un nombre sin
    // extensión que un nombre truncado a la mitad de la extensión.
    if (extBytes >= maxBytes) return "";
    extBudget = extBytes;
  }
  let budget = maxBytes - extBudget;
  let cut = stem;
  while (cut.length > 0 && utf8Length(cut) > budget) {
    // Recorta por CODE POINTS, no por unidades UTF-16: una unidad suelta de
    // un surrogate pair produce un carácter inválido en el nombre. Si la
    // última unidad es un surrogate BAJO, el par entero debe irse (2
    // unidades); si es un surrogate ALTO suelto, se va 1.
    const last = cut.charCodeAt(cut.length - 1);
    const isLowSurrogate = last >= 0xdc00 && last <= 0xdfff;
    const prev = cut.length >= 2 ? cut.charCodeAt(cut.length - 2) : 0;
    const isHighSurrogate = prev >= 0xd800 && prev <= 0xdbff;
    cut = cut.slice(0, cut.length - (isLowSurrogate && isHighSurrogate ? 2 : 1));
  }
  return cut + ext;
}

// Nombre de archivo SEGURO a partir de una cadena arbitraria (controlada por la
// página: alt, title, texto de un enlace, basename de la URL, header del
// servidor…). Devuelve siempre un nombre no vacío y sin separadores.
export function sanitizeFileName(raw, options) {
  const opts = options || {};
  const fallback = opts.fallback || "descarga";
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_MAX_BYTES;

  if (raw === null || raw === undefined) return fallback;
  let s = normalize(raw);

  // Los separadores se sustituyen por "_" en lugar de eliminarse: así
  // "..\..\evil.png" se convierte en ".._.._evil.png", que sigue siendo legible
  // para el usuario pero ya no es una ruta.
  s = s.replace(ILLEGAL_CHARS, "_");

  // Windows no admite puntos/espacios al final del nombre.
  s = s.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");

  // Restos de casos degenerados: una secuencia de solo guiones bajos tras el
  // recorte no informa de nada.
  if (!s || /^_+$/.test(s)) return fallback;

  let [stem, ext] = splitExt(s);

  // Nombres reservados: se antepone "_" al stem (CON → _CON).
  if (WIN_RESERVED.test(stem)) stem = "_" + stem;

  // Recorte por bytes preservando la extensión.
  const joined = truncateBytes(stem + ext, ext, maxBytes);
  if (!joined) return fallback;

  let [stem2, ext2] = splitExt(joined);
  if (WIN_RESERVED.test(stem2)) {
    stem2 = "_" + stem2;
    return truncateBytes(stem2 + ext2, ext2, maxBytes) || fallback;
  }
  return joined;
}

// Último segmento de la ruta de una URL, decodificado y saneado.
//
// El orden importa: se decodifica ANTES de sanear, de modo que un %2F que
//yclanía dentro del nombre se convierte en "_" en lugar de recuperar su
// significado de separador. Y se rechaza cualquier cosa que tras decodificar
// parezca una ruta.
export function basenameFromUrl(url, options) {
  const opts = options || {};
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  // Se parte por "/" sobre el pathname YA codificado (no puede contener %2F
  // decodificado todavía), y sólo entonces se decodifica el último segmento.
  const raw = pathname.split("/").filter(Boolean).pop() || "";
  if (!raw) return "";
  const decoded = safeDecode(raw);
  // Si al decodificar aparecieron separadores, el segmento era un truco de
  // path traversal: se descarta entero en lugar de intentar repararlo.
  if (/[\\/]/.test(decoded)) return "";
  return sanitizeFileName(decoded, { fallback: "", ...opts });
}

// RFC 6266 `filename*` (RFC 5987/8187) tiene prioridad sobre `filename`, que es
// ASCII y por tanto pierde cualquier carácter no representable.
// Devuelve el valor CRUDO (sin sanear) o null.
export function parseContentDisposition(header) {
  if (!header || typeof header !== "string") return null;

  // --- filename* = ext-value (charset "'" [language] "'" value-chars) ---
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const parts = star[1].trim().split("'");
    if (parts.length >= 3) {
      const charset = (parts[0] || "utf-8").toLowerCase();
      const value = parts.slice(2).join("'");
      const decoded = safeDecode(value);
      // Solo se acepta si el charset es uno que sabemos decodificar; el resto
      // de charsets HTTP son raros y aplicarles una decodificación utf-8
      // produciría basura.
      if (/^utf-?8$|^iso-8859-1$|^latin1$|^us-ascii$|^windows-1252$/.test(charset) && decoded) {
        return decoded;
      }
    }
  }

  // --- filename = value | "value" (con \" escapado dentro de comillas) ---
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) {
    const v = quoted[1].replace(/\\(.)/g, "$1");
    if (v) return v;
  }
  const bare = /filename\s*=\s*([^;"]+)/i.exec(header);
  if (bare) {
    const v = bare[1].trim();
    if (v) return v;
  }
  return null;
}

// Nombre final para un recurso HTTP, prefiriendo lo que propone el servidor.
// `res` puede ser un Response (tiene .headers) o null.
export function filenameFromResponse(res, url, options) {
  let cd = null;
  try {
    cd = res && res.headers ? parseContentDisposition(res.headers.get("content-disposition")) : null;
  } catch {
    cd = null;
  }
  if (cd) {
    // El nombre del servidor también es controlado por el sitio: se sanea con
    // las mismas reglas que el resto.
    const cleaned = sanitizeFileName(cd, { fallback: "", ...options });
    if (cleaned) return cleaned;
  }
  return basenameFromUrl(url, options);
}

// Extensión sugerida por Content-Type. Extensión mínima para cuando la URL no
// la trae (CDNs con rutas opacas: /download?token=…). `""` si no se conoce.
const MIME_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/mp2t": "ts",
  "video/mpeg": "mpeg",
  "video/iso.segment": "m4s",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "oga",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "weba",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  "application/json": "json",
  "text/plain": "txt",
  "text/html": "html",
  "text/css": "css",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/dash+xml": "mpd",
};

export function mimeToExt(mime) {
  if (!mime || typeof mime !== "string") return "";
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] || "";
}

// Añade la extensión si el nombre no trae una reconocible. `ext` sin punto.
export function ensureExtension(name, ext) {
  const e = (ext || "").replace(/^\./, "").toLowerCase();
  if (!e) return name;
  if (/\.[a-z0-9]{1,5}$/i.test(name)) return name;
  return `${name}.${e}`;
}

// Nombre único dentro de un conjunto, preservando la extensión:
// "video.mp4" → "video (2).mp4". A diferencia del patrón anterior del panel,
// parte SIEMPRE del nombre original (no del ya sustituido), así que la
// colisión N no puede acumular sufijos ("video_2_3.mp4").
export function uniqueFileName(name, used, options) {
  const opts = options || {};
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const taken = used instanceof Set ? used : new Set(used || []);
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const [stem, ext] = splitExt(name);
  for (let n = 2; n < 10000; n++) {
    const candidate = truncateBytes(`${stem} (${n})${ext}`, ext, maxBytes);
    if (candidate && !taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // pathological: 10000 colisiones del mismo nombre.
  const candidate = truncateBytes(`${stem} (${Date.now()})${ext}`, ext, maxBytes);
  taken.add(candidate);
  return candidate;
}

// Nombre de ENTRADA dentro de un ZIP. El zip es el único punto donde el
// nombre no pasa por el saneador de Chrome: la extensión se extrae con la
// herramienta que quiera el usuario, y un "../" o una ruta absoluta en el
// nombre es el patrón clásico de zip-slip. Aquí se garantiza que la entrada es
// un nombre PLANO dentro de la raíz del zip.
export function zipEntryName(name, used, options) {
  const opts = options || {};
  const flat = sanitizeFileName(String(name || "").replace(/[\\/]+/g, "_"), {
    fallback: "archivo",
    ...opts,
  });
  // Defensa explícita del invariante del zip-slip, aunque sanitizeFileName ya
  // lo cubre: si algo se colara, se recorta al último segmento legitimate.
  const lastSlash = Math.max(flat.lastIndexOf("/"), flat.lastIndexOf("\\"));
  const safe = lastSlash >= 0 ? flat.slice(lastSlash + 1) : flat;
  const noDrive = safe.replace(/^[a-zA-Z]:/, "");
  const noDots = noDrive.replace(/^\.+/, "");
  return uniqueFileName(noDots || "archivo", used, opts);
}

const Filename = {
  DEFAULT_MAX_BYTES,
  sanitizeFileName,
  basenameFromUrl,
  parseContentDisposition,
  filenameFromResponse,
  mimeToExt,
  ensureExtension,
  uniqueFileName,
  zipEntryName,
  splitExt,
  utf8Length,
};

if (typeof globalThis !== "undefined") globalThis.OperantFilename = Filename;

// --- Carga y exportación ---
// Este archivo es un MÓDULO (igual que media-core.js y hls-fast.js): lo
// importan el service worker (background.js) y el panel (panel.js). NO se
// añade a content_scripts, y no debe hacerlo: los content scripts son scripts
// clásicos y `export` es sintaxis inválida fuera de un módulo. El content
// script no necesita sanear nombres: los nombres que propone viajan al SW o
// al panel, y ambos los sanean antes de llamar a chrome.downloads.download.
//
// Compatibilidad con los tests: se publica en globalThis y, si existe un
// `module` de CommonJS, también en module.exports. Así el mismo archivo se
// puede cargar con require() (tests antiguos, tooling) o con import().
if (typeof module !== "undefined" && module.exports) {
  module.exports = Filename;
}

export default Filename;
