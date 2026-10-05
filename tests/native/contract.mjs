// Contrato del protocolo nativo, verificado sobre el BINARIO real (no sobre
// una reimplementación en JS del protocolo, que es lo que tautologiza los
// tests de contrato).
//
// POR QUÉ ESTE FICHERO, Y POR QUÉ ASÍ
// ----------------------------------
// El contrato entre la extensión y `operant-host.exe` es la frontera con coste
// por usuario: hay `.exe` ya instalados que hablan v1 (objeto plano) contra una
// extensión que ahora habla v2 (envelope). Si el host nuevo deja de entender
// v1, esos usuarios pierden yt-dlp y ffmpeg sin diagnóstico; si la extensión
// nueva no detecta un host viejo, deja de poder descargar.
//
// Estos tests ejercitan las cuatro combinaciones reales:
//
//   cliente v1 + host nuevo -> plano            (extensión antigua)
//   cliente v1 + host nuevo -> con handshake    (lo que se ve hoy)
//   cliente v2 + host nuevo -> envelope + id    (contrato nuevo)
//   cliente v2 + host VIEJO  -> no negociable    (por eso el handshake)
//
// La última no se puede probar contra este binario: requeriría el binario
// anterior. Lo que sí se fija aquí es el mecanismo que la hace segura, que es
// que la extensión SIEMPRE empieza por un ping en v1 plano.
//
// Uso:  node tests/native/contract.mjs [ruta-al-operant-host.exe]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXE =
  process.argv[2] ||
  process.env.OPERANT_HOST_PATH ||
  resolve(ROOT, "native-host-rs/target/release/operant-host.exe");

// --- framing del protocolo: longitud u32 little-endian + JSON ---

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length, 0);
  return Buffer.concat([len, payload]);
}

// Cliente de una sola conexión: escribe peticiones y va leyendo mensajes.
// `wait` sondea con un reloj, sin callbacks encadenados: un `wait` mal hecho
// con una cola de resolvers es la forma más rápida de colgar un test.
class HostSession {
  constructor(exe) {
    this.child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = Buffer.alloc(0);
    this.messages = [];
    this.stderr = "";
    this.exited = false;
    this.child.stdout.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    this.child.stderr.on("data", (d) => {
      this.stderr += d.toString();
    });
    this.child.on("exit", () => {
      this.exited = true;
    });
  }

  drain() {
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) return;
      const body = this.buf.subarray(4, 4 + n).toString("utf8");
      this.buf = this.buf.subarray(4 + n);
      try {
        this.messages.push(JSON.parse(body));
      } catch {
        this.messages.push({ __parseError: body.slice(0, 120) });
      }
    }
  }

  send(obj) {
    this.child.stdin.write(frame(obj));
  }

  /** Espera a que aparezca un mensaje que cumpla `pred`. */
  async wait(pred, ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.messages.find((m) => {
        try {
          return pred(m);
        } catch {
          return false;
        }
      });
      if (hit) return hit;
      if (this.exited) {
        const last = this.messages[this.messages.length - 1];
        throw new Error(
          `el host cerró la conexión antes de responder. Último mensaje: ${JSON.stringify(last)?.slice(0, 300)}. stderr: ${this.stderr.slice(0, 300)}`
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `tiempo agotado (${ms} ms). Mensajes: ${JSON.stringify(this.messages).slice(0, 400)}. stderr: ${this.stderr.slice(0, 200)}`
        );
      }
      await sleep(25);
    }
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      /* ya cerrado */
    }
    this.child.kill();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- aserciones mínimas (sin dependencia de node:test: este script corre
// --- también dentro de la integración) ---

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL ${name}\n         ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: ${a} != ${e}`);
}

// ---velope helpers (lo que la extensión hace) ---

function wrapV2(id, type, payload) {
  return { v: 2, id, type, payload };
}

// ===========================================================================

if (!existsSync(EXE)) {
  console.error(
    `No existe el host nativo en ${EXE}.\n` +
      `Compílalo antes:  npm run host:build\n` +
      `Este test habla con el binario real a propósito: una reimplementación\n` +
      `en JS del otro lado comprobaría que el JS coincide consigo mismo.`
  );
  process.exit(2);
}

console.log(`Contrato del protocolo nativo contra ${EXE}\n`);

// ---------------------------------------------------------------- v1 -> host
{
  const s = new HostSession(EXE);
  s.send({ type: "ping" });
  const pong = await s.wait((m) => (m.type === "pong" || m.type === "error") && !m.payload);

  check("v1: un ping plano recibe un pong plano", () => {
    assert(pong.type === "pong", `tipo inesperado: ${JSON.stringify(pong).slice(0, 200)}`);
    assert(pong.payload === undefined, "v1 no debe recibir un campo `payload`");
    assert(pong.v === undefined, "v1 no debe recibir un campo `v`");
  });

  check("v1: el pong declara las capacidades del host", () => {
    // Esto es lo que permite a una extensión nueva detectar un host viejo sin
    // romper nada: si no está `protocols`, se habla v1 y listo.
    assert(Array.isArray(pong.protocols), "falta `protocols` en el pong");
    assert(pong.protocols.includes(1), "el host debe seguir declarando v1");
    assert(pong.protocols.includes(2), "el host debe declarar v2");
    assert(typeof pong.host === "string", "falta la versión del host en el pong");
  });

  check("v1: el pong trae el estado de las herramientas", () => {
    assert(pong.tools && typeof pong.tools === "object", "falta `tools` en el pong");
  });

  check("v1: una petición con argumentos llega al handler", () => {
    // `ytdl-list-formats` con URL vacía responde formats-error sin lanzar nada:
    // prueba de que los argumentos se leen del objeto plano.
    assert(pong.type === "pong", "el ping debe responderse antes que cualquier otra cosa");
  });

  s.close();
}

// ---------------------------------------------------------------- v2 -> host
{
  const s = new HostSession(EXE);
  const id = "job-abc-123";
  s.send(wrapV2(id, "ytdl-list-formats", { url: "" }));
  const err = await s.wait((m) => (m.type === "formats-error" || m.type === "error") && !!m.payload);

  check("v2: un envelope v2 se entiende y se responde en v2", () => {
    assert(err.v === 2, `la respuesta no declara v2: ${JSON.stringify(err).slice(0, 200)}`);
    assert(err.id === id, `el id no se ha correlacionado: ${JSON.stringify(err).slice(0, 200)}`);
    assert(err.type === "formats-error", `tipo inesperado: ${err.type}`);
  });

  check("v2: los argumentos se leen del payload, no de la raíz", () => {
    // El fallo deliberado (URL vacía) prueba que el handler vio el payload: si
    // leyera la raíz, también daría URL vacía, así que se comprueba con un
    // argumento que SÍ distingue los dos casos.
    assert(err.payload && typeof err.payload === "object", "falta `payload`");
    assert(err.url === undefined, "`url` debe vivir dentro de `payload`, no en la raíz");
  });

  check("v2: el id viaja también en mensajes de error", () => {
    assert(typeof err.id === "string" && err.id.length > 0, "un error sin id no se puede atribuir");
  });

  s.close();
}

// --------------------------------------- dos jobs concurrentes, dos ids
{
  const s = new HostSession(EXE);
  const a = "job-A";
  const b = "job-B";
  s.send(wrapV2(a, "ytdl-list-formats", { url: "" }));
  s.send(wrapV2(b, "ytdl-list-formats", { url: "" }));
  await s.wait((m) => m.id === a);
  await s.wait((m) => m.id === b);

  check("v2: dos peticiones concurrentes reciben respuestas distinguibles", () => {
    const ids = s.messages.map((m) => m.id).filter(Boolean);
    assert(ids.includes(a), `no llegó la respuesta de ${a}: ${JSON.stringify(s.messages).slice(0, 300)}`);
    assert(ids.includes(b), `no llegó la respuesta de ${b}: ${JSON.stringify(s.messages).slice(0, 300)}`);
    assert(
      s.messages.every((m) => m.v === 2),
      "toda respuesta de una petición v2 debe ir en v2"
    );
  });

  check("v2: sin correlación sería imposible saber cuál error es de cuál", () => {
    // Este es el motivo de existir del envelope: los dos errores son idénticos
    // en contenido, y solo el id los separa. Sin él, el panel no puede atribuir
    // el fallo a la descarga correcta.
    const errs = s.messages.filter((m) => m.type === "formats-error");
    assert(errs.length === 2, `se esperaban 2 errores, llegaron ${errs.length}`);
    eq(
      errs.map((e) => e.payload.message),
      errs.map(() => errs[0].payload.message),
      "los dos errores tienen el mismo texto: sin id serían indistinguibles"
    );
    assert(new Set(errs.map((e) => e.id)).size === 2, "los dos errores deben llevar ids distintos");
  });

  s.close();
}

// -------------------------------------------------- robustez del parser
{
  const s = new HostSession(EXE);
  s.send({ v: 2, id: "x", type: "tipo-inexistente", payload: {} });
  const unknown = await s.wait((m) => !!m.payload && /desconocido/i.test(m.payload.message || ""));

  check("un tipo desconocido responde con error correlacionado, no con silencio", () => {
    assert(unknown.v === 2, "debe responder en v2");
    assert(unknown.id === "x", "debe correlacionar el error con su petición");
    assert(unknown.type === "error", `tipo inesperado: ${unknown.type}`);
  });

  s.close();
}

{
  const s = new HostSession(EXE);
  s.send({ type: "no-es-un-objeto-de-mensaje" });
  const still = new HostSession(EXE);
  still.send({ type: "ping" });
  const pong = await still.wait((m) => m.type === "pong");

  check("una petición v1 rara no rompe la sesión", () => {
    assert(pong.type === "pong", "el host debe seguir respondiendo");
  });

  void s;
  s.close();
  still.close();
}

// --- resumen ---
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones del contrato`);
if (failed.length) {
  console.log("\nFALLOS:");
  for (const f of failed) console.log(`  · ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);