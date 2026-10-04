// tests/unit/hls-fast.test.js — Motor HLS: IV, playlists y contenedores.
//
// Este archivo tenía CERO cobertura, y es el que contiene la descifrado AES-128
// de HLS: si un día un byte del IV se calcula mal, los segmentos salen
// descifrados como basura y el síntoma es un vídeo que no se reproduce — sin
// ningún error. Un test con vectores conocidos es la única red de seguridad.
//
// Uso:  node --test tests/unit/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { HLSFast } from "../../src/shared/hls-fast.js";

const { parseHexIv, sequenceIv, parseMaster, parseMedia } = HLSFast;

const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("parseHexIv — IV explícito en #EXT-X-KEY", () => {
  test("acepta hex con prefijo 0x", () => {
    assert.equal(bytesToHex(parseHexIv("0x000102030405060708090a0b0c0d0e0f")), "000102030405060708090a0b0c0d0e0f");
  });

  test("acepta hex sin prefijo", () => {
    assert.equal(bytesToHex(parseHexIv("000102030405060708090a0b0c0d0e0f")), "000102030405060708090a0b0c0d0e0f");
  });

  test("rellena a 16 bytes si el IV es más corto", () => {
    // RFC 8216 §5.2: el IV del manifest es un entero de 128 bits alineado a la
    // DERECHA (los bytes altos a cero).
    const iv = parseHexIv("0x01");
    assert.equal(iv.length, 16);
    assert.equal(bytesToHex(iv), "00000000000000000000000000000001");
  });

  test("si excede de 16 bytes conserva los 16 menos significativos", () => {
    const iv = parseHexIv("0xAABB" + "000102030405060708090a0b0c0d0e0f");
    assert.equal(iv.length, 16);
    assert.equal(bytesToHex(iv), "aabb000102030405060708090a0b0c0d");
  });

  test("devuelve null si no hay IV", () => {
    assert.equal(parseHexIv(""), null);
    assert.equal(parseHexIv("0x"), null);
    assert.equal(parseHexIv(null), null);
    assert.equal(parseHexIv(undefined), null);
    assert.equal(parseHexIv("ZZZZ"), null);
  });

  test("tolera separadores y mayúsculas (se ignoran, el hex es hex)", () => {
    assert.equal(bytesToHex(parseHexIv("0xAA:bb-cc")), "00000000000000000000000000aabbcc");
  });
});

describe("sequenceIv — IV implícito a partir de MEDIA-SEQUENCE", () => {
  // RFC 8216 §5.2: el IV es el número de secuencia como ENTERO de 128 bits
  // BIG-ENDIAN, alineado a la DERECHA.
  test("secuencia 0 -> IV todo a cero", () => {
    assert.equal(bytesToHex(sequenceIv(0)), "00000000000000000000000000000000");
  });

  test("secuencia 1 -> el último byte es 1", () => {
    assert.equal(bytesToHex(sequenceIv(1)), "00000000000000000000000000000001");
  });

  test("secuencia 256 -> big-endian, no little-endian", () => {
    // El error clásico: escribirlo en little-endian daría
    // 01000000000000000000000000000000 y la descifrado sería basura.
    assert.equal(bytesToHex(sequenceIv(256)), "00000000000000000000000000000100");
  });

  test("secuencia 1 como 16 bytes exactos", () => {
    const iv = sequenceIv(1);
    assert.equal(iv.length, 16);
    assert.equal(iv[15], 1);
    assert.equal(iv[0], 0);
  });

  test("números grandes: usa BigInt y no pierde precisión", () => {
    // Por encima de 2^53 un Number perdería precisión y el IV sería
    // incorrecto en silencio.
    const iv = sequenceIv(2 ** 53);
    assert.equal(iv.length, 16);
    const n = BigInt("0x" + bytesToHex(iv));
    assert.equal(n, 9007199254740992n);
  });

  test("números negativos y fraccionarios se degradan sin lanzar", () => {
    assert.equal(bytesToHex(sequenceIv(-5)), "00000000000000000000000000000000");
    assert.equal(bytesToHex(sequenceIv(1.7)), "00000000000000000000000000000001");
  });

  test("una MEDIA-SEQUENCE no numérica NO rompe el parseo", () => {
    // `BigInt(NaN)` lanza. Con un #EXT-X-MEDIA-SEQUENCE malformado ("abc",
    // vacío) eso tumbaba el playlist entero y con él la descarga.
    for (const bad of [NaN, undefined, null, "abc", "", Infinity, -Infinity]) {
      assert.doesNotThrow(() => sequenceIv(bad), `sequenceIv(${String(bad)}) lanzó`);
      assert.equal(bytesToHex(sequenceIv(bad)), "00000000000000000000000000000000");
    }
  });

  test("el IV es determinista", () => {
    assert.equal(bytesToHex(sequenceIv(42)), bytesToHex(sequenceIv(42)));
  });
});

describe("parseMaster — variantes y audio separado", () => {
  const MASTER = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="es",URI="audio/es.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1",AUDIO="a1"',
    "v360.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1",AUDIO="a1"',
    "v720.m3u8",
  ].join("\n");

  test("devuelve una variante por STREAM-INF, con bitrate y resolución", () => {
    const m = parseMaster(MASTER, "https://cdn.tld/hls/master.m3u8");
    assert.ok(m, "debe parsear");
    assert.equal(m.variants.length, 2);
    assert.deepEqual(
      m.variants.map((v) => v.bandwidth),
      [800000, 2400000]
    );
    assert.deepEqual(
      m.variants.map((v) => v.resolution),
      ["640x360", "1280x720"]
    );
  });

  test("las URLs son absolutas", () => {
    const m = parseMaster(MASTER, "https://cdn.tld/hls/master.m3u8");
    for (const v of m.variants) {
      assert.ok(v.url.startsWith("https://cdn.tld/hls/"), v.url);
    }
  });

  test("asocia el audio del grupo AUDIO= a cada variante", () => {
    // Es lo que permite descargar un m3u8 con audio separado sin depender del
    // companion: variante y pista de audio viajan juntas en la misma entrada.
    const m = parseMaster(MASTER, "https://cdn.tld/hls/master.m3u8");
    for (const v of m.variants) {
      assert.ok(v.audioUrl, `falta audioUrl en ${v.url}`);
      assert.ok(v.audioUrl.startsWith("https://cdn.tld/hls/"), v.audioUrl);
    }
  });

  test("una variante de vídeo no se marca audioOnly", () => {
    const m = parseMaster(MASTER, "https://cdn.tld/hls/master.m3u8");
    for (const v of m.variants) assert.equal(v.audioOnly, false);
  });

  test("un texto sin STREAM-INF no es un master", () => {
    assert.equal(parseMaster("#EXTM3U\n#EXTINF:4,\nseg.ts", "https://x/y.m3u8"), null);
    assert.equal(parseMaster("", "https://x/y.m3u8"), null);
    assert.equal(parseMaster(null, "https://x/y.m3u8"), null);
  });

  test("no explota con atributos raros", () => {
    const raro = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1",
      "a.m3u8",
      "#EXT-X-STREAM-INF:",
      "b.m3u8",
    ].join("\n");
    assert.doesNotThrow(() => parseMaster(raro, "https://cdn.tld/hls/master.m3u8"));
  });
});

describe("parseMedia — segmentos, clave y fin de lista", () => {
  test("lee segmentos con su duración y número de secuencia", () => {
    const MEDIA = ["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXTINF:4.0,", "seg0.ts", "#EXTINF:4.0,", "seg1.ts"].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.ok(m, "debe parsear");
    assert.equal(m.segments.length, 2);
    assert.ok(m.segments[0].url.endsWith("/seg0.ts"), m.segments[0].url);
    assert.equal(m.segments[0].duration, 4);
    assert.equal(m.segments[1].seq, 1, "seq debe ser monótono y estable");
    assert.equal(m.targetDuration, 4);
    assert.equal(m.durationSec, 8, "duración total = suma de EXTINF");
  });

  test("reconoce ENDLIST como VOD (no live)", () => {
    const MEDIA = ["#EXTM3U", "#EXTINF:4,", "a.ts", "#EXT-X-ENDLIST"].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.ok(m);
    assert.equal(m.live, false, "ENDLIST significa que no es live");
  });

  test("sin ENDLIST se considera live", () => {
    const MEDIA = ["#EXTM3U", "#EXTINF:4,", "a.ts"].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.equal(m.live, true);
  });

  test("respeta MEDIA-SEQUENCE como origen de la numeración", () => {
    const MEDIA = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:42", "#EXTINF:4,", "a.ts"].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.equal(m.mediaSequence, 42);
    assert.equal(m.segments[0].seq, 42, "el primer segmento es el de la secuencia");
  });

  test("la clave AES-128 viaja en el segmento que la usa", () => {
    const MEDIA = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.tld/key.bin",IV=0x00',
      "#EXTINF:4,",
      "seg0.ts",
    ].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.ok(m);
    assert.equal(m.encrypted, true);
    assert.ok(m.segments[0].key, "el segmento debe traer su clave");
    assert.equal(m.segments[0].key.method, "AES-128");
    assert.equal(m.segments[0].key.uri, "https://cdn.tld/key.bin");
    assert.equal(m.segments[0].key.iv.length, 16);
  });

  test("METHOD=NONE deja el contenido sin cifrar", () => {
    const MEDIA = ["#EXTM3U", "#EXT-X-KEY:METHOD=NONE", "#EXTINF:4,", "seg0.ts"].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.ok(m);
    assert.equal(m.encrypted, false);
  });

  test("SAMPLE-AES falla con un mensaje honesto (no se puede descifrar)", () => {
    const MEDIA = ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"', "#EXTINF:4,", "seg0.ts"].join("\n");
    // Es lo CORRECTO: preferimos un error claro a entregar basura cifrada.
    assert.throws(() => parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8"));
  });

  test("un texto sin segmentos no es un playlist de medios", () => {
    assert.equal(parseMedia("#EXTM3U\n", "https://x/y.m3u8"), null);
    assert.equal(parseMedia("", "https://x/y.m3u8"), null);
    assert.equal(parseMedia(null, "https://x/y.m3u8"), null);
  });

  test("no explota con líneas corruptras", () => {
    const roto = ["#EXTM3U", "#EXTINF:sin_numero", "sin-inf.ts", "#EXT-X-KEY:METHOD=", ""].join("\n");
    assert.doesNotThrow(() => parseMedia(roto, "https://cdn.tld/hls/v.m3u8"));
  });

  test("no explota con un baseUrl no válido", () => {
    const MEDIA = ["#EXTM3U", "#EXTINF:4,", "seg0.ts"].join("\n");
    assert.doesNotThrow(() => parseMedia(MEDIA, "no-es-una-url"));
  });

  test("no explota con una MEDIA-SEQUENCE no numérica", () => {
    const MEDIA = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:abc", "#EXTINF:4,", "a.ts"].join("\n");
    assert.doesNotThrow(() => parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8"));
  });

  test("EXT-X-DISCONTINUITY se detecta y se propaga al resultado", () => {
    const MEDIA = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4",
      "#EXTINF:4,", "a.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4,", "b.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.ok(m);
    assert.equal(m.hasDiscontinuity, true, "el corte debe quedar registrado");
    assert.equal(m.segments[0].discontinuity, false);
    assert.equal(m.segments[1].discontinuity, true, "el corte precede al segmento nuevo");
  });

  test("un METHOD desconocido falla en vez de conservar la clave anterior", () => {
    // Antes la cadena if/else if no tenía `else`: `currentKey` se quedaba con
    // la clave VIGENTE y los segmentos siguientes se "descifraban" con una
    // clave que no era la suya (o sin descifrar), todoUx informing
    // `encrypted: true` como si estuviera correcto.
    const MEDIA = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.tld/key.bin"',
      "#EXTINF:4,", "seg0.ts",
      '#EXT-X-KEY:METHOD=AES-128-LWR,URI="https://cdn.tld/key2.bin"',
      "#EXTINF:4,", "seg1.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    assert.throws(() => parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8"), /no soportado/i);
  });

  test("el parser de atributos de EXT-X-KEY respeta las comillas", () => {
    // Una URI con coma (muy habitual: signed URLs con listas de parámetros)
    // debe leerse ENTERA. Un regex que parte los atributos por comas la
    // truncaba en el primer `,` y pedía una clave que no existe.
    const MEDIA = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.tld/k.bin?a=1,2",IV=0x0f,KEYFORMAT="identity",KEYFORMATVERSIONS="1,2"',
      "#EXTINF:4,", "seg0.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const m = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.ok(m);
    assert.equal(m.segments[0].key.uri, "https://cdn.tld/k.bin?a=1,2");
    assert.equal(bytesToHex(m.segments[0].key.iv), "0000000000000000000000000000000f");
    assert.equal(m.encrypted, true);
  });
});

// --- Red de pruebas: exercises el motor de extremo a extremo ---------------

// `fetch` simulado con las tres piezas que el motor usa: `ok`, `status`,
// `arrayBuffer()` y `text()`. Además honra la cabecera `Range`, que es lo que
// permite comprobar los offsets de byterange sin salir a la red.
function makeNet(routes) {
  const calls = [];
  const fetchImpl = async (u, opts = {}) => {
    calls.push({ url: String(u), opts });
    let route = routes[String(u)];
    if (typeof route === "function") route = await route(opts, calls.length - 1);
    if (route === undefined) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
    }
    if (route && route.__status) {
      return { ok: false, status: route.__status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
    }
    const bytes = route instanceof Uint8Array ? route : new TextEncoder().encode(String(route));
    let body = bytes;
    const range = opts.headers && opts.headers.Range;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      if (m) body = bytes.slice(Number(m[1]), Number(m[2]) + 1);
    }
    const copy = body.slice();
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      text: async () => new TextDecoder().decode(copy),
    };
  };
  return { fetchImpl, calls };
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

describe("downloadHls — de extremo a extremo", () => {
  test("descifra AES-128 con el IV DERIVADO de la secuencia (RFC 8216 §5.2)", async () => {
    HLSFast.clearKeyCache();
    // Cifrado de verdad con la misma primitiva que usa el motor (WebCrypto
    // AES-CBC): si `sequenceIv` devolviera un IV mal alineado, o si
    // `decryptAes128` invirtiera el orden, el texto plano no coincidiría.
    const KEY = Uint8Array.from(nodeCrypto.randomBytes(16));
    const SEQ = 7;
    const iv = HLSFast.sequenceIv(SEQ);
    const plain = Buffer.from("contenido-descifrado-exacto-del-segmento-cifrado");
    const c = nodeCrypto.createCipheriv("aes-128-cbc", KEY, Buffer.from(iv));
    const cipher = new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
    const PLAYLIST = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:7",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.tld/hls/k.bin"',
      "#EXTINF:4,", "seg0.ts", "#EXT-X-ENDLIST",
    ].join("\n");
    const { fetchImpl } = makeNet({
      "https://cdn.tld/hls/v.m3u8": PLAYLIST,
      "https://cdn.tld/hls/k.bin": KEY,
      "https://cdn.tld/hls/seg0.ts": cipher,
    });
    const r = await HLSFast.downloadHls({ url: "https://cdn.tld/hls/v.m3u8", fetchImpl, concurrency: 1 });
    assert.equal(r.encrypted, true);
    assert.equal(new TextDecoder().decode(await bytesOf(r.blob)), plain.toString("utf8"));
  });

  test("la clave se pide por el MISMO camino que los segmentos (fallback de credenciales)", async () => {
    HLSFast.clearKeyCache();
    const KEY = Uint8Array.from(nodeCrypto.randomBytes(16));
    const plain = Buffer.from("segundo-testeo-del-fallback-de-credenciales");
    const iv = HLSFast.sequenceIv(0);
    const c = nodeCrypto.createCipheriv("aes-128-cbc", KEY, Buffer.from(iv));
    const cipher = new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
    const PLAYLIST = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.tld/hls/k.bin"',
      "#EXTINF:4,", "seg0.ts", "#EXT-X-ENDLIST",
    ].join("\n");
    const { fetchImpl, calls } = makeNet({
      "https://cdn.tld/hls/v.m3u8": PLAYLIST,
      // CDN sin `Access-Control-Allow-Credentials`: con cookies se rechaza la
      // petición de red y hay que reintentar sin ellas. Antes la clave NO
      // tenía ese fallback, así que el stream entero moría en este 4xx.
      "https://cdn.tld/hls/k.bin": (opts) => {
        if (opts.credentials === "include") throw new TypeError("Failed to fetch");
        return KEY;
      },
      "https://cdn.tld/hls/seg0.ts": cipher,
    });
    const r = await HLSFast.downloadHls({ url: "https://cdn.tld/hls/v.m3u8", fetchImpl, concurrency: 1 });
    assert.equal(new TextDecoder().decode(await bytesOf(r.blob)), plain.toString("utf8"));
    const keyCalls = calls.filter((c) => c.url.endsWith("k.bin")).map((c) => c.opts.credentials);
    assert.deepEqual(keyCalls, ["include", "omit"], "la clave debe reintentar sin credenciales");
  });

  test("la clave se reintenta ante un fallo transitorio", async () => {
    HLSFast.clearKeyCache();
    const KEY = Uint8Array.from(nodeCrypto.randomBytes(16));
    const plain = Buffer.from("reintento-transitorio-de-la-clave-aes");
    const c = nodeCrypto.createCipheriv("aes-128-cbc", KEY, Buffer.from(HLSFast.sequenceIv(0)));
    const cipher = new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
    const PLAYLIST = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.tld/hls/k.bin"',
      "#EXTINF:4,", "seg0.ts", "#EXT-X-ENDLIST",
    ].join("\n");
    let keyHits = 0;
    const { fetchImpl } = makeNet({
      "https://cdn.tld/hls/v.m3u8": PLAYLIST,
      "https://cdn.tld/hls/k.bin": () => (++keyHits === 1 ? { __status: 503 } : KEY),
      "https://cdn.tld/hls/seg0.ts": cipher,
    });
    const r = await HLSFast.downloadHls({ url: "https://cdn.tld/hls/v.m3u8", fetchImpl, concurrency: 1, retries: 2 });
    assert.equal(new TextDecoder().decode(await bytesOf(r.blob)), plain.toString("utf8"));
    assert.equal(keyHits, 2, "debe reintentar la clave una vez");
  });

  test("los EXT-X-MAP de cada periodo se colocan EN SU POSICIÓN (orden exacto de bytes)", async () => {
    HLSFast.clearKeyCache();
    // Dos periodos con init propio. Antes todos los init se volcaban al
    // principio, y en orden de FINALIZACIÓN de descarga (nondeterminista con
    // concurrencia): los `trex` de un periodo se aplicaban a los segmentos del
    // otro y el MP4 resultante no se abría.
    const PLAYLIST = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="init0.mp4"',
      "#EXTINF:4,", "seg0.m4s",
      "#EXT-X-DISCONTINUITY",
      '#EXT-X-MAP:URI="init1.mp4"',
      "#EXTINF:4,", "seg1.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const b = (tag) => new Uint8Array(Array.from({ length: 8 }, (_, i) => i + tag.charCodeAt(0)));
    const { fetchImpl } = makeNet({
      "https://cdn.tld/hls/v.m3u8": PLAYLIST,
      "https://cdn.tld/hls/init0.mp4": b("I0"),
      "https://cdn.tld/hls/seg0.m4s": b("S0"),
      "https://cdn.tld/hls/init1.mp4": b("I1"),
      "https://cdn.tld/hls/seg1.m4s": b("S1"),
    });
    const r = await HLSFast.downloadHls({ url: "https://cdn.tld/hls/v.m3u8", fetchImpl, concurrency: 4 });
    assert.equal(r.kind, "fmp4");
    assert.equal(r.hasDiscontinuity, true, "el corte se propaga al llamador");
    const expected = new Uint8Array(32);
    expected.set(b("I0"), 0);
    expected.set(b("S0"), 8);
    expected.set(b("I1"), 16);
    expected.set(b("S1"), 24);
    assert.deepEqual([...await bytesOf(r.blob)], [...expected], "init0+seg0+init1+seg1, en ese orden exacto");
  });

  test("el init se descarga UNA vez y se reutiliza dentro del periodo", async () => {
    HLSFast.clearKeyCache();
    const PLAYLIST = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:4,", "a.m4s", "#EXTINF:4,", "b.m4s", "#EXT-X-ENDLIST",
    ].join("\n");
    const { fetchImpl, calls } = makeNet({
      "https://cdn.tld/hls/v.m3u8": PLAYLIST,
      "https://cdn.tld/hls/init.mp4": new Uint8Array([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70]),
      "https://cdn.tld/hls/a.m4s": new Uint8Array([9, 9, 9, 9]),
      "https://cdn.tld/hls/b.m4s": new Uint8Array([8, 8, 8, 8]),
    });
    await HLSFast.downloadHls({ url: "https://cdn.tld/hls/v.m3u8", fetchImpl, concurrency: 2 });
    const initFetches = calls.filter((c) => c.url.endsWith("init.mp4")).length;
    assert.equal(initFetches, 1, "el init es un recurso compartido, no uno por segmento");
  });

  test("el contenedor se detecta SIEMPRE con los bytes del segmento 0", async () => {
    HLSFast.clearKeyCache();
    // TS puro (byte de sync 0x47) en el segmento 0; un fMP4 lento en el 1.
    // Antes `firstBytes` era el del PRIMERO EN TERMINAR, así que el mismo
    // stream se podía clasificar como mp4 o como ts según la carrera.
    const PLAYLIST = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4",
      "#EXTINF:4,", "s0.ts", "#EXTINF:4,", "s1.ts", "#EXT-X-ENDLIST",
    ].join("\n");
    const { fetchImpl } = makeNet({
      "https://cdn.tld/hls/v.m3u8": PLAYLIST,
      "https://cdn.tld/hls/s0.ts": new Uint8Array([0x47, 0x40, 0x00, 0x10, 0, 0, 0, 0]),
      "https://cdn.tld/hls/s1.ts": new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
    });
    for (let i = 0; i < 12; i++) {
      const r = await HLSFast.downloadHls({ url: "https://cdn.tld/hls/v.m3u8", fetchImpl, concurrency: 6 });
      assert.equal(r.kind, "ts", "el segmento 0 es MPEG-TS: el tipo no puede depender de la carrera");
    }
  });

  test("en live, un byterange con offset implícito NO reinicia en cada sondeo", async () => {
    HLSFast.clearKeyCache();
    // Un único recurso de 8 bytes troceado en dos. El segundo tramo declara
    // `#EXT-X-BYTERANGE:4` sin offset, que significa "continúa donde acabó el
    // anterior" (RFC 8216 §4.3.2.2). Con el cursor reiniciado en cada poll se
    // pedía SIEMPRE bytes=0-3 y se duplicaba el primer tramo.
    const P1 = ["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-BYTERANGE:4@0", "#EXTINF:4,", "all.ts"].join("\n");
    const P2 = ["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:1", "#EXT-X-BYTERANGE:4", "#EXTINF:4,", "all.ts", "#EXT-X-ENDLIST"].join("\n");
    const resource = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let polls = 0;
    const { fetchImpl, calls } = makeNet({
      "https://cdn.tld/hls/live.m3u8": () => (++polls === 1 ? P1 : P2),
      "https://cdn.tld/hls/all.ts": resource,
    });
    const r = await HLSFast.downloadHlsLive({
      url: "https://cdn.tld/hls/live.m3u8",
      fetchImpl,
      concurrency: 1,
      pollIntervalMs: 10,
    });
    const ranges = calls.filter((c) => c.url.endsWith("all.ts")).map((c) => c.opts.headers && c.opts.headers.Range);
    assert.deepEqual(ranges, ["bytes=0-3", "bytes=4-7"], "el segundo tramo debe continuar, no repetir");
    assert.deepEqual([...await bytesOf(r.blob)], [1, 2, 3, 4, 5, 6, 7, 8], "y el resultado son los 8 bytes");
  });

  test("clearKeyCache devuelve los cursores de byterange a su estado inicial", () => {
    HLSFast.clearKeyCache();
    const MEDIA = ["#EXTM3U", "#EXT-X-BYTERANGE:4", "#EXTINF:4,", "x.ts"].join("\n");
    const a = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.equal(a.segments[0].byterange.offset, 0, "sin estado heredado arranca en 0");
    const b = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.equal(b.segments[0].byterange.offset, 4, "dentro de la misma descarga continúa");
    HLSFast.clearKeyCache();
    const c = parseMedia(MEDIA, "https://cdn.tld/hls/v.m3u8");
    assert.equal(c.segments[0].byterange.offset, 0, "tras limpiar, una descarga nueva empieza en 0");
  });
});