// tests/unit/filename.test.js — Invariantes del saneo de nombres de archivo.
//
// Estos tests cubren un módulo que ANTES no existía: no había forma de probar
// el saneo porque el nombre se derivaba en tres sitios distintos
// (background.js, panel.js y el host Rust) sin ninguna función común.
//
// Uso:  node --test tests/unit/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFileName,
  basenameFromUrl,
  parseContentDisposition,
  mimeToExt,
  ensureExtension,
  uniqueFileName,
  zipEntryName,
  splitExt,
  utf8Length,
  DEFAULT_MAX_BYTES,
} from "../../src/shared/filename.js";

// ¿Contiene la cadena algún surrogate UTF-16 SIN pareja (carácter inválido)?
// Un surrogate emparejado es normal (emoji); uno suelto es un bug.
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    const isLow = c >= 0xdc00 && c <= 0xdfff;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

describe("sanitizeFileName — ninguna ruta puede salir de su directorio", () => {
  test("un %2F que ocultaba un separador no produce separadores", () => {
    // El defecto original: urlBasename() hacía split("/") y LUEGO
    // decodeURIComponent, así que un %2F percent-encoded sobrevivía al nombre.
    const out = sanitizeFileName("a/../../evil.png");
    assert.ok(!out.includes("/"), `no debe contener "/": ${out}`);
    assert.ok(!out.includes("\\"), `no debe contener "\\": ${out}`);
  });

  test("una ruta absoluta se aplana", () => {
    for (const input of ["/etc/passwd", "C:\\Windows\\evil.dll", "//servidor/recurso"]) {
      const out = sanitizeFileName(input);
      assert.ok(!out.includes("/") && !out.includes("\\"), `${input} -> ${out}`);
    }
  });

  test("no se puede escapar con ..", () => {
    const out = sanitizeFileName("../../../../root/.ssh/authorized_keys");
    // Lo peligroso es el SEPARADOR: sin él el nombre es un único segmento y no
    // puede escalar directorios. Que sobrevivan los puntos es inofensivo (y
    // desirable: el usuario ve de dónde viene el recurso).
    assert.ok(!out.includes("/"), out);
    assert.ok(!out.includes("\\"), out);
    assert.ok(!out.includes("/"), out);
  });

  test("un nombre que sea solo .. no puede pasar como directorio", () => {
    // Chrome interpretaría `filename: ".."` como el directorio padre.
    for (const evil of ["..", "../", "..\\", "/..", "./.."]) {
      const out = sanitizeFileName(evil);
      assert.notEqual(out, "..", `${evil} -> ${out}`);
      assert.ok(!out.includes("/") && !out.includes("\\"), `${evil} -> ${out}`);
    }
  });

  test("las barras invertidas también se sustituyen", () => {
    const out = sanitizeFileName("..\\..\\startup.lnk");
    assert.ok(!out.includes("\\"), out);
    assert.equal(out, "_.._startup.lnk");
  });
});

describe("sanitizeFileName — nombres reservados de Windows", () => {
  // https://learn.microsoft.com/windows/win32/fileio/naming-a-file
  const reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"];
  for (const name of reserved) {
    test(`"${name}" queda neutralizado`, () => {
      const out = sanitizeFileName(name);
      assert.notEqual(out.toUpperCase(), name, `sigue siendo reservado: ${out}`);
      assert.ok(out.startsWith("_"), out);
    });
  }

  test("la forma CON.extensión también es inválida en Win32 y se neutraliza", () => {
    // CON.png sigue siendo el dispositivo CON en Windows.
    for (const name of ["CON.png", "nul.mp4", "AUX.jpg"]) {
      const out = sanitizeFileName(name);
      const stem = splitExt(out)[0];
      assert.notEqual(stem.toUpperCase(), "CON");
      assert.notEqual(stem.toUpperCase(), "NUL");
      assert.notEqual(stem.toUpperCase(), "AUX");
    }
  });

  test("un nombre legítimo que solo empieza por uno reservado se conserva", () => {
    assert.equal(sanitizeFileName("console.png"), "console.png");
    assert.equal(sanitizeFileName("comunicado.pdf"), "comunicado.pdf");
    assert.equal(sanitizeFileName("auxiliar.txt"), "auxiliar.txt");
  });
});

describe("sanitizeFileName — suplantación mediante caracteres invisibles", () => {
  test("se elimina el override bidireccional U+202E (gpj.exe -> exe.jpg)", () => {
    // La peor inspección posible sin esto: el archivo se llama "exe.txt" y
    // Windows lo muestra como "txt.exe".
    const out = sanitizeFileName("gpj\u202Eexe.txt");
    assert.ok(!out.includes("\u202E"), out);
    assert.equal(out, "gpjexe.txt");
  });

  test("se eliminan LRM/RLM y zero-width", () => {
    for (const ch of ["\u200e", "\u200f", "\u200b", "\u200d", "\ufeff", "\u202a", "\u2066"]) {
      const out = sanitizeFileName(`a${ch}b.txt`);
      assert.ok(!out.includes(ch), `${JSON.stringify(ch)} sobrevivió: ${out}`);
    }
  });

  test("se eliminan los controles C0 y C1", () => {
    const out = sanitizeFileName("a\u0000b\u0001c\u007fd.txt");
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out));
  });
});

describe("sanitizeFileName — caracteres ilegales de Windows", () => {
  test("sustituye los que Windows prohíbe en un nombre", () => {
    const out = sanitizeFileName('bad:name*here?.mp4');
    assert.equal(out, "bad_name_here_.mp4");
  });

  test("quita puntos y espacios finales (inválidos en Win32)", () => {
    assert.equal(sanitizeFileName("  spaces  .mp4  "), "spaces  .mp4");
    assert.equal(sanitizeFileName("puntos..."), "puntos");
  });

  test("no toca los caracteres legales que se confunden con ilegales", () => {
    // La coma, el punto y coma y los signos + son legales en Windows.
    assert.equal(sanitizeFileName("a,b;c+d.mp4"), "a,b;c+d.mp4");
  });
});

describe("sanitizeFileName — unicode y longitud", () => {
  test("normaliza a NFC (evita duplicados por é precompuesta vs descompuesta)", () => {
    const nfd = "e\u0301.png"; // "e" + acento combinante
    const nfc = "\u00e9.png"; // "é" precompuesta
    assert.equal(sanitizeFileName(nfd), nfc);
    assert.equal(utf8Length(sanitizeFileName(nfd)), utf8Length(nfc));
  });

  test("acota por bytes UTF-8 preservando la extensión", () => {
    const out = sanitizeFileName("a".repeat(500) + ".mp4");
    assert.ok(utf8Length(out) <= DEFAULT_MAX_BYTES, `${utf8Length(out)} bytes`);
    assert.ok(out.endsWith(".mp4"), out);
  });

  test("el recorte no parte un surrogate pair", () => {
    // Un emoji son 2 unidades UTF-16 y 4 bytes UTF-8. Un recorte a ciegas por
    // bytes deja UN surrogate suelto, que es un carácter inválido en el nombre
    // (y una cadena que no es UTF-8 válido).
    //
    // Ojo: un emoji válido TAMBIÉN contiene surrogates (D83C-DFFC), así que
    // comprobar `/[\uD800-\uDFFF]/` daría falso positivo. Hay que buscar
    // surrogates SINaparear.
    const out = sanitizeFileName("\u{1F3AC}".repeat(80) + ".mp4");
    assert.ok(!hasLoneSurrogate(out), "surrogate suelto en el nombre");
    assert.ok(utf8Length(out) <= DEFAULT_MAX_BYTES);
    assert.ok(out.endsWith(".mp4"), out);
  });

  test("también con emojis en mayúsculas/minúsculas mezcladas", () => {
    const out = sanitizeFileName("\u{1F3AC}\u{1F44D}\u{1F926}".repeat(60) + ".mp4");
    assert.ok(!hasLoneSurrogate(out), "surrogate suelto en el nombre");
    assert.ok(utf8Length(out) <= DEFAULT_MAX_BYTES);
  });

  test("si la extensión sola no cabe, se descarta antes que truncar el nombre", () => {
    const out = sanitizeFileName("archivo.mp4", { maxBytes: 6 });
    assert.ok(utf8Length(out) <= 6, JSON.stringify(out));
  });
});

describe("sanitizeFileName — nunca devuelve vacío", () => {
  const degenerate = ["", "   ", "...", "___", "/", "\\", "..", null, undefined, "\u0000"];
  for (const input of degenerate) {
    test(`entrada degenerada ${JSON.stringify(input)} devuelve un fallback`, () => {
      const out = sanitizeFileName(input);
      assert.ok(typeof out === "string" && out.length > 0, JSON.stringify(out));
      assert.ok(!out.includes("/") && !out.includes("\\"), out);
    });
  }

  test("respeta el fallback pedido", () => {
    assert.equal(sanitizeFileName("", { fallback: "captura" }), "captura");
    assert.equal(sanitizeFileName("...", { fallback: "captura" }), "captura");
  });
});

describe("basenameFromUrl — decodificar ANTES de sanear", () => {
  test("rechaza un segmento cuyo %2F se convierte en separador", () => {
    // Es el ataque: la página pide este nombre y el resultado sería una ruta.
    assert.equal(basenameFromUrl("https://x.tld/a%2F..%2F..%2Fevil.png"), "");
  });

  test("decodifica caracteres legítimos", () => {
    assert.equal(basenameFromUrl("https://x.tld/f%C3%B6o.mp4"), "föo.mp4");
    assert.equal(basenameFromUrl("https://x.tld/dir/photo.jpg?token=abc"), "photo.jpg");
  });

  test("no inventa un nombre cuando la URL no tiene basename", () => {
    assert.equal(basenameFromUrl("https://x.tld/"), "");
    assert.equal(basenameFromUrl("https://x.tld"), "");
  });

  test("tolera percent-encoding malformado sin reventar", () => {
    // decodeURIComponent lanza URIError con "%zz" o "%E0%A4%A".
    assert.equal(basenameFromUrl("https://x.tld/%zz.mp4"), "%zz.mp4");
    assert.doesNotThrow(() => basenameFromUrl("https://x.tld/%E0%A4%A.mp4"));
  });

  test("elimina el RLO también cuando viene en la URL", () => {
    assert.equal(basenameFromUrl("https://x.tld/x/%E2%80%AEgpj.exe"), "gpj.exe");
  });

  test("una URL inválida no lanza", () => {
    assert.doesNotThrow(() => basenameFromUrl("no-es-una-url"));
    assert.doesNotThrow(() => basenameFromUrl(""));
  });
});

describe("parseContentDisposition — RFC 6266 / 5987", () => {
  test("filename entre comillas", () => {
    assert.equal(
      parseContentDisposition('attachment; filename="video.mp4"'),
      "video.mp4"
    );
  });

  test("filename* tiene prioridad y se decodifica (UTF-8)", () => {
    // filename* es la forma correcta para no-ASCII; filename es ASCII y
    // perdería el carácter.
    assert.equal(
      parseContentDisposition("attachment; filename*=UTF-8''Caf%C3%A9%20%2B%20m%C3%BAsica.mp4"),
      "Café + música.mp4"
    );
  });

  test("filename* gana cuando ambos están presentes", () => {
    const header = "attachment; filename=\"fallback.bin\"; filename*=UTF-8''real.png";
    assert.equal(parseContentDisposition(header), "real.png");
  });

  test("soporta el valor sin comillas", () => {
    assert.equal(parseContentDisposition("attachment; filename=video.mp4"), "video.mp4");
  });

  test("permite escapes dentro de las comillas", () => {
    assert.equal(parseContentDisposition('attachment; filename="a\\"b.mp4"'), 'a"b.mp4');
  });

  test("ignora un charset que no sabemos decodificar", () => {
    // Aplicar utf-8 a un valor en Shift_JIS produciría basura: mejor null.
    assert.equal(parseContentDisposition("attachment; filename*=SHIFT_JIS'%82%A0.mp4"), null);
  });

  test("sin filename devuelve null", () => {
    assert.equal(parseContentDisposition("inline"), null);
    assert.equal(parseContentDisposition(""), null);
    assert.equal(parseContentDisposition(null), null);
    assert.equal(parseContentDisposition(undefined), null);
  });

  test("no rompe con un header corrupto", () => {
    assert.doesNotThrow(() => parseContentDisposition("attachment; filename*=UTF-8''"));
    assert.doesNotThrow(() => parseContentDisposition(";;;==="));
  });
});

describe("mimeToExt / ensureExtension", () => {
  test("mapea los tipos habituales", () => {
    assert.equal(mimeToExt("video/mp4"), "mp4");
    assert.equal(mimeToExt("video/mp4; codecs=avc1"), "mp4");
    assert.equal(mimeToExt("IMAGE/AVIF"), "avif");
    assert.equal(mimeToExt("application/vnd.apple.mpegurl"), "m3u8");
  });

  test("devuelve vacío si no se conoce", () => {
    assert.equal(mimeToExt("application/x-desconocido"), "");
    assert.equal(mimeToExt(null), "");
  });

  test("ensureExtension no duplica una extensión existente", () => {
    assert.equal(ensureExtension("foo", "jpg"), "foo.jpg");
    assert.equal(ensureExtension("foo.png", "jpg"), "foo.png");
    assert.equal(ensureExtension("foo", ""), "foo");
    assert.equal(ensureExtension("foo", ".jpg"), "foo.jpg");
  });
});

describe("uniqueFileName — deduplicación sin acumulación de sufijos", () => {
  test("numera de forma estable y sin encadenar", () => {
    const used = new Set();
    assert.equal(uniqueFileName("v.mp4", used), "v.mp4");
    assert.equal(uniqueFileName("v.mp4", used), "v (2).mp4");
    assert.equal(uniqueFileName("v.mp4", used), "v (3).mp4");
    // El defecto anterior re-sustituía sobre el nombre ya modificado, lo que
    // podía producir "v_2_3.mp4".
    assert.ok(![...used].some((n) => /_\d+_\d+/.test(n)), [...used].join(", "));
  });

  test("conserva la extensión al numerar", () => {
    // La extensión es el ÚLTIMO punto (como hace Chrome y el Explorador de
    // archivos), así que "video.tar.gz" se numera como "video.tar (2).gz".
    const used = new Set();
    uniqueFileName("video.tar.gz", used);
    assert.equal(uniqueFileName("video.tar.gz", used), "video.tar (2).gz");
  });

  test("respeta el límite de bytes al numerar", () => {
    const used = new Set();
    const base = "a".repeat(150) + ".mp4";
    uniqueFileName(base, used);
    const second = uniqueFileName(base, used, { maxBytes: 180 });
    assert.ok(utf8Length(second) <= 180, `${utf8Length(second)} bytes`);
  });
});

describe("zipEntryName — el ZIP es el punto sin sanear de Chrome", () => {
  test("aplana rutas (zip-slip)", () => {
    const used = new Set();
    for (const evil of ["../../etc/passwd", "..\\..\\evil.png", "/abs/x.png", "C:\\x.png"]) {
      const entry = zipEntryName(evil, used);
      assert.ok(!entry.includes("/"), `${evil} -> ${entry}`);
      assert.ok(!entry.includes("\\"), `${evil} -> ${entry}`);
      assert.ok(!entry.startsWith("."), `${evil} -> ${entry}`);
    }
  });

  test("deduplica dentro del mismo zip", () => {
    const used = new Set();
    assert.equal(zipEntryName("a.png", used), "a.png");
    assert.equal(zipEntryName("a.png", used), "a (2).png");
  });

  test("nunca devuelve una entrada vacía", () => {
    const used = new Set();
    assert.ok(zipEntryName("", used).length > 0);
    assert.ok(zipEntryName("...", used).length > 0);
  });
});

describe("splitExt — la extensión es el último punto no inicial", () => {
  test("casos normales y borde", () => {
    assert.deepEqual(splitExt("a.b.c"), ["a.b", ".c"]);
    assert.deepEqual(splitExt(".hidden"), [".hidden", ""]);
    assert.deepEqual(splitExt("sin"), ["sin", ""]);
    // Un punto final da una extensión "." sin sentido, pero sanitizeFileName
    // elimina los puntos finales antes de llamar a splitExt, así que es
    // inalcanzable desde el saneador.
    assert.deepEqual(splitExt("archivo."), ["archivo", "."]);
  });
});
