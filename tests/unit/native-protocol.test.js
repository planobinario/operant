// tests/unit/native-protocol.test.js - El contrato con operant-host.exe, del
// lado del navegador.
//
// Estos tests usan el MISMO módulo que el service worker y el panel
// (`src/shared/native-protocol.js`), no una copia. Y el módulo es puro: no toca
// `chrome.*`. Así que esto no es tautológico en el sentido habitual, pero SÍ es
// complementario del `tests/native/contract.mjs`, que habla con el binario real:
// aquí se fija la lógica del cliente (negociación y desenvoltura), allí se fija
// que el host cumple.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_V1,
  PROTOCOL_V2,
  buildRequest,
  negotiate,
  nextRequestId,
  parseResponse,
  wrapV2,
  isTerminal,
} from "../../src/shared/native-protocol.js";

describe("buildRequest — forma según lo negociado", () => {
  test("sin protocolo declarado (host viejo) sale plano", () => {
    const r = buildRequest("ytdl", { url: "u", format: "b" }, null, "id-1");
    assert.deepEqual(r, { type: "ytdl", url: "u", format: "b" });
    assert.equal(r.payload, undefined);
    assert.equal(r.v, undefined);
  });

  test("con v2 sale envuelto y los argumentos van al payload", () => {
    const r = buildRequest("ytdl", { url: "u", format: "b" }, PROTOCOL_V2, "id-1");
    assert.equal(r.v, 2);
    assert.equal(r.id, "id-1");
    assert.equal(r.type, "ytdl");
    assert.deepEqual(r.payload, { url: "u", format: "b" });
    assert.equal(r.url, undefined, "en v2 los argumentos NO van en la raíz");
  });

  test("con v2 pero sin id degrada a plano en vez de emitir un envelope sin correlacionar", () => {
    // Un envelope sin `id` es peor que uno plano: el panel recibiría mensajes
    // que no puede atribuir y no tendría forma de notarlo.
    const r = buildRequest("ffmpeg-op", { url: "u" }, PROTOCOL_V2, null);
    assert.equal(r.v, undefined);
    assert.equal(r.type, "ffmpeg-op");
    assert.equal(r.url, "u");
  });

  test("no muta el objeto de argumentos", () => {
    const args = { url: "u" };
    buildRequest("ytdl", args, PROTOCOL_V2, "x");
    assert.deepEqual(args, { url: "u" });
  });

  test("wrapV2 con payload ausente produce un payload vacío, no undefined", () => {
    const r = wrapV2("x", "ping");
    assert.deepEqual(r.payload, {});
  });
});

describe("negotiate — el handshake decide sin romper a nadie", () => {
  test("un host que declara 2 se negocia a v2", () => {
    assert.equal(negotiate({ protocols: [1, 2] }), PROTOCOL_V2);
  });

  test("un host viejo (sin protocols) se queda en v1", () => {
    assert.equal(negotiate({ protocols: undefined }), PROTOCOL_V1);
    assert.equal(negotiate({}), PROTOCOL_V1);
    assert.equal(negotiate(undefined), PROTOCOL_V1);
  });

  test("un host que solo declara v1 se queda en v1", () => {
    assert.equal(negotiate({ protocols: [1] }), PROTOCOL_V1);
  });

  test("`protocol: 2` sin `protocols` NO cuenta como capacidad", () => {
    // Si un host declarase una versión sin confirmar que sigue hablando v1, el
    // cliente no podría distinguirlo de un host que no entiende el envelope. La
    // capacidad tiene que probarse, no declararse.
    assert.equal(negotiate({ protocol: 2 }), PROTOCOL_V1);
  });

  test("protocols con basura no concede v2", () => {
    assert.equal(negotiate({ protocols: "2" }), PROTOCOL_V1);
    assert.equal(negotiate({ protocols: [1, "2"] }), PROTOCOL_V1);
    assert.equal(negotiate({ protocols: null }), PROTOCOL_V1);
  });
});

describe("parseResponse — desenvolver lo que llegue", () => {
  test("respuesta plana de un host viejo", () => {
    const r = parseResponse({ type: "pong", tools: { ffmpeg: {} } });
    assert.equal(r.type, "pong");
    assert.equal(r.id, null);
    assert.equal(r.protocol, PROTOCOL_V1);
    assert.deepEqual(r.fields.tools, { ffmpeg: {} });
  });

  test("respuesta v2 con id", () => {
    const r = parseResponse({ v: 2, id: "job-7", type: "ffmpeg-progress", payload: { progress: 40 } });
    assert.equal(r.type, "ffmpeg-progress");
    assert.equal(r.id, "job-7");
    assert.equal(r.protocol, PROTOCOL_V2);
    assert.equal(r.fields.progress, 40);
  });

  test("un cliente v1Ignore con elegancia un envelope: el panel no ve la forma", () => {
    // Un host futuro que respondiese siempre en v2 no rompería el panel: tras
    // desenvolver, `type` y los campos están donde el panel siempre los busca.
    const r = parseResponse({ v: 2, id: "x", type: "done", payload: { folder: "D" } });
    assert.equal(r.type, "done");
    assert.equal(r.fields.folder, "D");
  });

  test("un campo `type` dentro del payload no se confunde con el tipo", () => {
    const r = parseResponse({ v: 2, type: "rec-append", payload: { type: "audio", data: "…" } });
    assert.equal(r.type, "rec-append");
    assert.equal(r.fields.type, "audio");
  });

  test("basura no revienta", () => {
    for (const bad of [null, undefined, 42, "hola", [], true]) {
      const r = parseResponse(bad);
      assert.equal(r.type, "", `tipo inesperado para ${JSON.stringify(bad)}`);
      assert.deepEqual(r.fields, {});
    }
  });

  test("un mensaje sin `type` en v1 no se pierde: el resto de campos sigue disponible", () => {
    const r = parseResponse({ folder: "D", name: "n" });
    assert.equal(r.type, "");
    assert.equal(r.fields.folder, "D");
  });
});

describe("nextRequestId — correlación", () => {
  test("los ids no se repiten", () => {
    const ids = new Set();
    for (let i = 0; i < 5000; i++) ids.add(nextRequestId());
    assert.equal(ids.size, 5000, "colisión de ids: el panel no podría atribuir nada");
  });

  test("acepta un prefijo", () => {
    assert.match(nextRequestId("rec"), /^rec-/);
  });

  test("no usa nada del entorno de navegador", () => {
    // Se importa en Node sin `crypto` ni `chrome`: si esto dependiera de
    // randomUUID, el test de protocolo no podría correr fuera del navegador.
    assert.equal(typeof nextRequestId(), "string");
  });
});

describe("isTerminal — qué mensajes cierran un job", () => {
  test("los terminales están clasificados", () => {
    for (const t of ["done", "error", "ffmpeg-done", "ffmpeg-error", "formats-error", "rec-error"]) {
      assert.equal(isTerminal(t), true, t);
    }
  });

  test("los de progreso NO son terminales", () => {
    for (const t of ["progress", "ffmpeg-progress", "tool-progress", "stdio", "pong", "formats"]) {
      assert.equal(isTerminal(t), false, t);
    }
  });
});
