// tests/unit/media-core.test.js — Clasificación, magic bytes y parsers de
// manifiesto.
//
// Este archivo tenía CERO cobertura mientras concentraba la "única fuente de
// verdad" de la clasificación: aquí viven los parsers de HLS/DASH, la detección
// por magic bytes y el box-walk de MP4. Ninguno de esos caminos se ejercitaba
// salvo cuando el usuario hacía clic en descargar.
//
// `parseManifest` SIEMPRE hace fetch (los `firstBytes` solo sirven de pista para
// deducir el tipo), así que los tests inyectan un `fetch` simulado. Sin eso los
// tests dependerían de la red y no serían tests.
//
// Uso:  node --test tests/unit/

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OperantMedia } from "../../src/shared/media-core.js";

const { detectMagic, extOf, classifyExt, mediaVerdict } = OperantMedia;

// --- Utilidades para construir cabeceras de archivo reales -------------------

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// Caja fMP4/MPEG-4 válida: size(4) + 'ftyp' + minorVersion(4) + majorBrand(4)
// + compatible brands.
function riff(form) {
  const b = new Uint8Array(16);
  b.set(ascii("RIFF"), 0);
  b.set(ascii(form), 8);
  return b;
}

function ftypBox(majorBrand, compatible = ["isom", "mp42"]) {
  const brands = compatible;
  const size = 16 + brands.length * 4;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, size, false);
  b.set(ascii("ftyp"), 4);
  v.setUint32(8, 0x200, false); // minor version
  b.set(ascii(majorBrand), 12);
  brands.forEach((br, i) => b.set(ascii(br), 16 + i * 4));
  return b;
}

// --- fetch simulado ---------------------------------------------------------

const realFetch = globalThis.fetch;
let mockedRoutes = new Map();

function mockFetch(routes) {
  mockedRoutes = new Map(Object.entries(routes));
  globalThis.fetch = async (url) => {
    const key = [...mockedRoutes.keys()].find((k) => String(url).includes(k));
    if (key === undefined) return { ok: false, status: 404, headers: new Map(), text: async () => "" };
    const body = mockedRoutes.get(key);
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => body,
      arrayBuffer: async () => ascii(body).buffer,
    };
  };
}

beforeEach(() => {});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("detectMagic — firmas de archivo reales", () => {
  test("PNG", () => {
    assert.equal(detectMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  });

  test("JPEG", () => {
    assert.equal(detectMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), "jpeg");
  });

  test("GIF (87a y 89a)", () => {
    assert.equal(detectMagic(ascii("GIF87a")), "gif");
    assert.equal(detectMagic(ascii("GIF89a")), "gif");
  });

  test("WebP (RIFF....WEBP)", () => {
    const b = new Uint8Array(16);
    b.set(ascii("RIFF"), 0);
    b.set(ascii("WEBP"), 8);
    assert.equal(detectMagic(b), "webp");
  });

  test("MP4 (brand isom)", () => {
    assert.equal(detectMagic(ftypBox("isom")), "mp4");
  });

  test("HLS (.m3u8 por texto)", () => {
    assert.equal(detectMagic(ascii("#EXTM3U\n#EXTINF:4,")), "hls");
  });

  test("DASH (.mpd por XML)", () => {
    assert.equal(detectMagic(ascii('<?xml version="1.0"?><MPD')), "dash");
  });

  test("MP3 (ID3)", () => {
    assert.equal(detectMagic(ascii("ID3\u0004")), "mp3");
  });

  test("un búfer vacío o demasiado corto no lanza", () => {
    assert.equal(detectMagic(new Uint8Array(0)), "");
    assert.equal(detectMagic(new Uint8Array([1, 2])), "");
    assert.equal(detectMagic(null), "");
    assert.equal(detectMagic(undefined), "");
  });

  test("un búfer grande no revienta por límite de argumentos", () => {
    const big = new Uint8Array(64 * 1024);
    big.set(ftypBox("isom"), 0);
    assert.equal(detectMagic(big), "mp4");
  });

  test("AVIF se detecta por su marca, no como mp4", () => {
    // `ftyp` es un campo de MARCA, no de tipo. Tratar cualquier ftyp como mp4
    // clasificaba una imagen como vídeo: la UI ofrecía "descargar vídeo" y el
    // fichero se guardaba con extensión equivocada.
    assert.equal(detectMagic(ftypBox("avif", ["mif1", "miaf"])), "avif");
    assert.equal(detectMagic(ftypBox("avis", ["avif"])), "avif");
  });

  test("HEIC/HEIF se distinguen de AVIF", () => {
    assert.equal(detectMagic(ftypBox("heic", ["mif1"])), "heic");
    assert.equal(detectMagic(ftypBox("heix", ["mif1"])), "heic");
    assert.equal(detectMagic(ftypBox("mif1")), "avif");
  });

  test("M4A no se clasifica como mp4", () => {
    assert.equal(detectMagic(ftypBox("M4A ", ["M4A ", "mp42"])), "m4a");
  });

  test("los fragmentos CMAF (.m4s) se distinguen de un MP4 completo", () => {
    // cmfc/cmfv son TROZOS: no se descargan sueltos.
    assert.equal(detectMagic(ftypBox("cmfc", ["iso6"])), "m4s");
    assert.equal(detectMagic(ftypBox("cmfa")), "m4s");
  });

  test("las marcas ISO-BMFF de vídeo siguen siendo mp4", () => {
    assert.equal(detectMagic(ftypBox("isom", ["isom", "mp42"])), "mp4");
    assert.equal(detectMagic(ftypBox("dash", ["iso6"])), "mp4");
    assert.equal(detectMagic(ftypBox("avc1", ["mp42"])), "mp4");
  });

  test("formatos sin ftyp: BMP, TIFF, ICO, FLAC, Ogg, WAV y AVI", () => {
    assert.equal(detectMagic(new Uint8Array([0x42, 0x4d, 0x00, 0x00])), "bmp");
    assert.equal(detectMagic(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), "tiff");
    assert.equal(detectMagic(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a])), "tiff");
    assert.equal(detectMagic(new Uint8Array([0x00, 0x00, 0x01, 0x00])), "ico");
    assert.equal(detectMagic(ascii("fLaC")), "flac");
    assert.equal(detectMagic(ascii("OggS")), "ogg");
    assert.equal(detectMagic(riff("WAVE")), "wav");
    assert.equal(detectMagic(riff("AVI ")), "avi");
  });
});

describe("extOf / classifyExt", () => {
  test("extOf saca la extensión del pathname", () => {
    assert.equal(extOf("https://x.tld/a/b/foto.JPG"), "jpg");
    assert.equal(extOf("https://x.tld/video.mp4"), "mp4");
    assert.equal(extOf("https://x.tld/dir/pic.png?token=abc"), "png");
  });

  test("extOf devuelve vacío si no hay extensión", () => {
    assert.equal(extOf("https://x.tld/descarga"), "");
    assert.equal(extOf("no-url"), "");
  });

  test("classifyExt reconoce los grupos principales", () => {
    assert.equal(classifyExt("https://x.tld/a.jpg"), "image");
    assert.equal(classifyExt("https://x.tld/a.mp4"), "video");
    assert.equal(classifyExt("https://x.tld/a.mp3"), "audio");
    assert.equal(classifyExt("https://x.tld/a.pdf"), "file");
  });

  test("el query string NO decide el tipo", () => {
    // Antes el regex se aplicaba a la URL completa, así que cualquier parámetro
    // con una extensión al final reetiquetaba el recurso. Una página podía
    // forzar que un vídeo apareciera como imagen en el panel.
    assert.notEqual(classifyExt("https://cdn.tld/seg1.ts?ref=https://otro/logo.png"), "image");
    assert.equal(classifyExt("https://cdn.tld/seg1.ts?ref=https://otro/logo.png"), "video");
    assert.notEqual(classifyExt("https://site/watch?v=1&poster=https://cdn/p.jpg"), "image");
  });

  test("un parámetro de formato conocido sí se consulta", () => {
    // /download?id=123&format=mp4 es un patrón real de CDN.
    assert.equal(classifyExt("https://cdn.tld/get?format=mp4"), "video");
  });

  test("un parámetro arbitrario NO decide el tipo", () => {
    // ?file=logo.png no convierte un recurso opaco en imagen.
    assert.equal(classifyExt("https://cdn.tld/get?file=logo.png"), null);
  });

  test(".ts se resuelve con criterios, no por su extensión a secas", () => {
    // MPEG-TS (segmento HLS) y TypeScript comparten extensión.
    assert.equal(classifyExt("https://cdn.tld/live/seg-001.ts"), "video");
    assert.equal(classifyExt("https://x.tld/src/app.ts"), "file");
    assert.equal(classifyExt("https://x.tld/lib/util.ts"), "file");
    assert.equal(classifyExt("https://x.tld/types/index.d.ts"), "file");
    assert.equal(classifyExt("https://x.tld/stream.ts?type=typescript"), "file");
  });

  test("un segmento .m4s no se clasifica como medio descargable", () => {
    assert.equal(classifyExt("https://cdn.tld/seg.m4s"), null);
  });
});

describe("mediaVerdict — qué es realmente la respuesta", () => {
  test("una página HTML de error no es un medio", () => {
    // Evita descargar 40 KB de HTML con nombre .mp4.
    assert.equal(mediaVerdict({ contentType: "text/html; charset=utf-8" }), "html");
    assert.equal(mediaVerdict({ contentType: "application/xhtml+xml" }), "html");
  });

  test("un manifiesto se reconoce como manifiesto", () => {
    assert.equal(mediaVerdict({ contentType: "application/vnd.apple.mpegurl" }), "manifest");
    assert.equal(mediaVerdict({ contentType: "application/dash+xml" }), "manifest");
  });

  test("un medio real no es html ni manifiesto", () => {
    assert.equal(mediaVerdict({ contentType: "video/mp4" }), "media");
  });

  test("sin datos no inventa un veredicto", () => {
    assert.equal(mediaVerdict(null), "unknown");
    assert.equal(mediaVerdict({}), "unknown");
  });
});

// Master realista: el STREAM-INF lleva AUDO="a1" para apuntar al grupo de
// audio separado definido arriba. Sin ese atributo no hay nada que asociar.
const MASTER = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="es",URI="audio/es.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1",AUDIO="a1"',
  "v360.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1",AUDIO="a1"',
  "v720.m3u8",
].join("\n");

const MEDIA = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXTINF:4.0,",
  "seg0.ts",
  "#EXTINF:4.0,",
  "seg1.ts",
  "#EXT-X-ENDLIST",
].join("\n");

// MPD realista: el parser exige <Representation> con bandwidth dentro de cada
// <AdaptationSet>; sin Representations no hay nada que devolver.
const MPD = [
  '<?xml version="1.0"?>',
  '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="P0DT0H0M8S">',
  "<Period>",
  '<AdaptationSet mimeType="video/mp4">',
  '<SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" duration="4" timescale="1" startNumber="1" />',
  '<Representation id="v0" bandwidth="800000" width="640" height="360"></Representation>',
  "</AdaptationSet>",
  "</Period>",
  "</MPD>",
].join("\n");

// MPD con Representations pero SIN ningún SegmentTemplate: es el caso que
// Provocaba el TypeError documentado (tpl === null y luego tpl.media).
const MPD_NO_TEMPLATE = [
  '<?xml version="1.0"?>',
  '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>',
  '<AdaptationSet mimeType="video/mp4">',
  '<Representation id="v0" bandwidth="800000"></Representation>',
  "</AdaptationSet></Period></MPD>",
].join("\n");

describe("parseManifest — HLS master", () => {
  test("devuelve una entrada por variante, con id y etiqueta de bitrate", async () => {
    mockFetch({ "master.m3u8": MASTER });
    const m = await OperantMedia.parseManifest("https://cdn.tld/hls/master.m3u8", "application/vnd.apple.mpegurl");
    assert.ok(m, "debe devolver un manifest");
    assert.equal(m.type, "hls-master");
    assert.ok(Array.isArray(m.segments), "segments debe ser un array");
    assert.equal(m.segments.length, 2, "dos variantes");
    assert.deepEqual(
      m.segments.map((s) => s.id),
      ["800000", "2400000"]
    );
    assert.equal(m.segments[0].label, "0.8 Mbps");
    assert.equal(m.segments[1].label, "2.4 Mbps");
  });

  test("las URLs de variante son absolutas", async () => {
    mockFetch({ "master.m3u8": MASTER });
    const m = await OperantMedia.parseManifest("https://cdn.tld/hls/master.m3u8", "application/vnd.apple.mpegurl");
    for (const s of m.segments) {
      assert.ok(s.url.startsWith("https://cdn.tld/hls/"), s.url);
    }
  });

  test("asocia el audio del master a cada variante (Nivel B sin host)", async () => {
    // Es lo que permite descargar un m3u8 con audio separado sin depender del
    // companion: la variante y su pista de audio viajan juntas.
    mockFetch({ "master.m3u8": MASTER });
    const m = await OperantMedia.parseManifest("https://cdn.tld/hls/master.m3u8", "application/vnd.apple.mpegurl");
    for (const s of m.segments) {
      assert.ok(s.audioUrl, `la variante ${s.id} debe traer audioUrl`);
      assert.ok(s.audioUrl.startsWith("https://cdn.tld/hls/"), s.audioUrl);
    }
  });

  test("sin grupo de audio, audioUrl es null (no se inventa)", async () => {
    mockFetch({
      "solo-video.m3u8": [
        "#EXTM3U",
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1"',
        "v.m3u8",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/hls/solo-video.m3u8", "application/vnd.apple.mpegurl");
    assert.ok(m);
    assert.equal(m.segments[0].audioUrl, null);
  });
});

describe("parseManifest — HLS media playlist", () => {
  test("devuelve los segmentos", async () => {
    mockFetch({ "/v.m3u8": MEDIA });
    const m = await OperantMedia.parseManifest("https://cdn.tld/hls/v.m3u8", "application/vnd.apple.mpegurl");
    assert.ok(m, "debe devolver un manifest");
    assert.equal(m.type, "hls");
    assert.ok(Array.isArray(m.segments));
  });

  test("no explota con un manifest corrupto", async () => {
    mockFetch({ "/broken.m3u8": "\u0000\u0001\u0002 no es un playlist" });
    await assert.doesNotReject(() =>
      OperantMedia.parseManifest("https://cdn.tld/hls/broken.m3u8", "application/vnd.apple.mpegurl")
    );
  });

  test("devuelve null si el tipo no es HLS ni DASH", async () => {
    mockFetch({});
    const m = await OperantMedia.parseManifest("https://cdn.tld/video.mp4", "video/mp4");
    assert.equal(m, null);
  });

  test("las URLs relativas se resuelven contra el manifest completo (RFC 3986)", async () => {
    // Antes la base era `url.slice(0, url.lastIndexOf("/") + 1)`, que parte la
    // URL INCLUDINGO la query: un manifest en /v.m3u8?path=a/b producía la base
    // ".../v.m3u8?path=a/" y TODOS los segmentos colgantes daban 404.
    mockFetch({ "/v.m3u8": MEDIA });
    const m = await OperantMedia.parseManifest(
      "https://cdn.tld/hls/v.m3u8?path=a/b&token=xyz",
      "application/vnd.apple.mpegurl",
      ascii(MEDIA)
    );
    assert.ok(m);
    assert.equal(m.segments[0], "https://cdn.tld/hls/seg0.ts", m.segments[0]);
  });

  test("NO se espera <base href>: en HLS las relativas se resuelven contra el manifest", async () => {
    // Este requisito estaba anotado como pendiente y era INCORRECTO: RFC 8216
    // §4.1 dice que las URL relativas de un playlist se resuelven contra la URL
    // del propio playlist. <base href> es un concepto de HTML, no de HLS, y el
    // manifest se descarga como texto: no hay documento al que pertenecer.
    mockFetch({ "/v.m3u8": MEDIA });
    const m = await OperantMedia.parseManifest(
      "https://cdn.tld/hls/sub/dir/v.m3u8",
      "application/vnd.apple.mpegurl",
      ascii(MEDIA)
    );
    assert.ok(m);
    assert.equal(m.segments[0], "https://cdn.tld/hls/sub/dir/seg0.ts");
  });

  test("EXT-X-MAP (init segment) se incluye y va PRIMERO", async () => {
    // Sin el init, un fMP4 no tiene moov/trak y no se reproduce.
    const FMP4 = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:4.0,",
      "seg0.m4s",
      "#EXTINF:4.0,",
      "seg1.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n");
    mockFetch({ "/fmp4.m3u8": FMP4 });
    const m = await OperantMedia.parseManifest("https://cdn.tld/hls/fmp4.m3u8", "application/vnd.apple.mpegurl", ascii(FMP4));
    assert.ok(m);
    assert.equal(m.initUrl, "https://cdn.tld/hls/init.mp4");
    assert.equal(m.segments[0], "https://cdn.tld/hls/init.mp4", "el init va primero");
    assert.equal(m.segments.length, 3, "init + 2 segmentos");
  });
});

describe("parseManifest — DASH", () => {
  test("un MPD con Representation y SegmentTemplate se parsea", async () => {
    mockFetch({ "manifest.mpd": MPD });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/manifest.mpd", "application/dash+xml");
    assert.ok(m, "no debe devolver null");
    assert.ok(Array.isArray(m.segments), "segments debe ser un array");
    assert.ok(m.segments.length > 0, "debe devolver al menos una calidad");
  });

  test("expande $Number$ y la inicialización con URL absoluta", async () => {
    mockFetch({ "manifest.mpd": MPD });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/manifest.mpd", "application/dash+xml");
    const q = m.segments[0];
    assert.ok(q.initUrl, "debe derivar el init segment");
    assert.ok(q.initUrl.startsWith("https://cdn.tld/dash/"), q.initUrl);
    for (const s of q.segments) {
      assert.ok(s.startsWith("https://cdn.tld/dash/"), s);
      assert.ok(!s.includes("$Number$"), `sin placeholders sin expandir: ${s}`);
    }
    assert.ok(q.segments.length > 1, "8 s con segmentos de 4 s debe dar 2 segmentos, no 1");
  });

  test("un XML que no es MPD no se interpreta como DASH", async () => {
    mockFetch({ "error.mpd": "<html><body>403 Forbidden</body></html>" });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/error.mpd", "application/dash+xml");
    assert.equal(m, null, "una página de error no es un manifest");
  });

  test("un AdaptationSet sin Representation se ignora sin lanzar", async () => {
    mockFetch({
      "vacio.mpd": [
        '<?xml version="1.0"?>',
        '<MPD><Period><AdaptationSet mimeType="video/mp4">',
        '<SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" />',
        "</AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    await assert.doesNotReject(() =>
      OperantMedia.parseManifest("https://cdn.tld/dash/vacio.mpd", "application/dash+xml")
    );
  });

  // Estos son los defectos que hacían que el host nativo descargara UN
  // segmento del DASH y declarara "éxito".
  test("una Representation sin template NO aborta el manifest", async () => {
    // Antes `tpl` era null y `tpl.media` lanzaba TypeError, lo que abortaba el
    // manifest DASH COMPLETO: una sola Representation mal formada impedía
    // descargar el vídeo entero.
    mockFetch({
      "mixto.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT8S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v0" bandwidth="800000"></Representation>',
        '<Representation id="v1" bandwidth="1600000">',
        '<SegmentTemplate media="s-$Number$.m4s" duration="4" timescale="1" startNumber="1" />',
        "</Representation>",
        "</AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/mixto.mpd", "application/dash+xml");
    assert.ok(m, "el manifest debe parsear");
    assert.equal(m.segments.length, 1, "solo la Representation con template aporta algo");
    assert.equal(m.segments[0].segments.length, 2);
  });

  test("el template de una Representation NO se hereda a las demás", async () => {
    // El template del AdaptationSet se buscaba en su cuerpo entero, así que el
    // de la primera Representation se aplicaba a todas.
    mockFetch({
      "heredado.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT8S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v0" bandwidth="800000"></Representation>',
        '<Representation id="v1" bandwidth="1600000">',
        '<SegmentTemplate media="solo-v1-$Number$.m4s" duration="4" timescale="1" startNumber="1" />',
        "</Representation>",
        "</AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/heredado.mpd", "application/dash+xml");
    assert.ok(m);
    for (const s of m.segments) {
      for (const u of s.segments) assert.ok(u.includes("solo-v1-"), `no debe heredar v0: ${u}`);
    }
  });

  test("un SegmentTemplate a nivel Representation se parsea", async () => {
    // Antes se buscaba en `m[0]`, que es el tag de APERTURA de la
    // Representation: un <SegmentTemplate> hijo nunca podía aparecer ahí.
    mockFetch({
      "reptpl.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT8S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v720" bandwidth="2400000">',
        '<SegmentTemplate media="seg-$RepresentationID$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" duration="4" timescale="1" startNumber="1" />',
        "</Representation>",
        "</AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/reptpl.mpd", "application/dash+xml");
    assert.ok(m);
    assert.ok(m.segments.length > 0);
    assert.equal(m.segments[0].segments.length, 2);
  });

  test("$RepresentationID$ se expande con el id, no con el bandwidth", async () => {
    mockFetch({
      "repid.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT8S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v720" bandwidth="2400000">',
        '<SegmentTemplate media="seg-$RepresentationID$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" duration="4" timescale="1" startNumber="1" />',
        "</Representation>",
        "</AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/repid.mpd", "application/dash+xml");
    const q = m.segments[0];
    assert.equal(q.initUrl, "https://cdn.tld/dash/init-v720.mp4", q.initUrl);
    assert.equal(q.segments[0], "https://cdn.tld/dash/seg-v720-1.m4s", q.segments[0]);
    for (const u of q.segments) assert.ok(!u.includes("2400000"), `no debe usar bandwidth: ${u}`);
  });

  test("DASH: SegmentTimeline con $Time$ y r= fija los tiempos", async () => {
    // Con SegmentTimeline la línea de tiempo la DECLARA el manifest. Antes se
    // ignoraba y el número de segmentos se deducía de duración_total/duración,
    // que con `d` variable no cuadra: se pedían segmentos que no existían (404)
    // y faltaban los que sí.
    mockFetch({
      "tl.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT10S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v" bandwidth="800000">',
        '<SegmentTemplate media="s-$Number$-$Time$.m4s" initialization="i.mp4" timescale="1000" startNumber="5">',
        '<SegmentTimeline><S t="0" d="2000" r="2"/><S d="4000"/></SegmentTimeline>',
        "</SegmentTemplate>",
        "</Representation></AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/tl.mpd", "application/dash+xml");
    assert.ok(m);
    const q = m.segments[0];
    assert.equal(q.initUrl, "https://cdn.tld/dash/i.mp4");
    // `r="2"` son DOS repeticiones ADICIONALES: 3 segmentos, no 2. El segundo
    // <S> sin `t` continúa donde acabó el anterior (t=6000).
    assert.deepEqual(q.segments, [
      "https://cdn.tld/dash/s-5-0.m4s",
      "https://cdn.tld/dash/s-6-2000.m4s",
      "https://cdn.tld/dash/s-7-4000.m4s",
      "https://cdn.tld/dash/s-8-6000.m4s",
    ]);
  });

  test("DASH: SegmentTimeline con r=-1 repite hasta el fin del Period", async () => {
    mockFetch({
      "tlr.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT10S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v" bandwidth="800000">',
        '<SegmentTemplate media="s-$Number$.m4s" timescale="1000" startNumber="1">',
        '<SegmentTimeline><S t="0" d="2000" r="-1"/></SegmentTimeline>',
        "</SegmentTemplate>",
        "</Representation></AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/tlr.mpd", "application/dash+xml");
    const q = m.segments[0];
    // 10 s a timescale 1000, en tramos de 2000 = 5 segmentos.
    assert.equal(q.segments.length, 5, q.segments.join(", "));
    assert.equal(q.segments[4], "https://cdn.tld/dash/s-5.m4s");
  });

  test("DASH: un SegmentTimeline degenerado no genera una lista infinita", async () => {
    mockFetch({
      "tldeg.mpd": [
        '<?xml version="1.0"?>',
        '<MPD><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v" bandwidth="800000">',
        '<SegmentTemplate media="s-$Number$.m4s" timescale="1" startNumber="1">',
        '<SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline>',
        "</SegmentTemplate>",
        "</Representation></AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/tldeg.mpd", "application/dash+xml");
    // Sin duración de periodo, `r="-1"` no tiene techo: el motor corta por el
    // guard interno. Lo que no puede hacer es colgarse allocating.
    const q = m.segments[0];
    assert.ok(q.segments.length <= 100000, "debe estar acotado");
    assert.ok(q.segments.length > 0);
  });

  test("DASH: un SegmentTimeline sin duration sigue mandando sobre el cálculo", async () => {
    mockFetch({
      "tlnodur.mpd": [
        '<?xml version="1.0"?>',
        '<MPD mediaPresentationDuration="PT600S"><Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<Representation id="v" bandwidth="800000">',
        '<SegmentTemplate media="s-$Number$.m4s" timescale="1000" startNumber="1">',
        '<SegmentTimeline><S d="3000" r="1"/></SegmentTimeline>',
        "</SegmentTemplate>",
        "</Representation></AdaptationSet></Period></MPD>",
      ].join("\n"),
    });
    const m = await OperantMedia.parseManifest("https://cdn.tld/dash/tlnodur.mpd", "application/dash+xml");
    // Sin `duration` en el template, el fallback daría 1 segmento (o 200 con
    // la regla de duración total). La timeline dice 2.
    assert.equal(m.segments[0].segments.length, 2);
  });
});

describe("Constantes exportadas", () => {
  test("EXT agrupa las extensiones por tipo", () => {
    assert.ok(OperantMedia.EXT, "EXT debe existir");
    for (const k of ["image", "video", "audio", "file"]) {
      assert.ok(OperantMedia.EXT[k], `EXT.${k} debe existir`);
    }
  });

  test("los conjuntos de descarga directa son Set", () => {
    for (const k of ["DIRECT_VIDEO", "DIRECT_IMAGE", "DIRECT_AUDIO", "DIRECT_FILE"]) {
      assert.ok(OperantMedia[k] instanceof Set, `${k} debe ser un Set`);
      assert.ok(OperantMedia[k].size > 0, `${k} no debe estar vacío`);
    }
  });

  test("m4s (segmentos fMP4) NO debe estar en DIRECT_VIDEO", () => {
    // Un segmento .m4s no es un archivo: es un trozo. Si estuviera en el set
    // de "descarga directa", el panel ofrecería descargarlo suelto y produciría
    // un archivo inservible.
    assert.ok(!OperantMedia.DIRECT_VIDEO.has("m4s"), "m4s no es descargable por sí solo");
  });
});
