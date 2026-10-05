# Protocolo del host nativo

Contrato entre la extensión (`src/background.js`) y `operant-host.exe`
(`native-host-rs/`). Es la frontera con coste por usuario: hay `.exe` ya
instalados que hablan v1, y la extensión puede hablar con un host viejo o nuevo
sin que nadie tenga que reinstalar nada.

## Framing

Native Messaging: longitud `uint32` little-endian + JSON UTF-8, por stdin/stdout.
Lo implementa `protocol.rs` y no ha cambiado desde el principio.

## v1 (histórico, sigue vivo)

Objeto plano. El discriminante `type` va en la raíz y el resto de campos también.

```json
{"type": "ytdl", "url": "https://…", "format": "bestaudio/best"}
{"type": "pong", "tools": {"ffmpeg": {…}, "yt-dlp": {…}}, "protocols": [1, 2]}
```

## v2 (actual)

Envelope con versión y correlación.

```json
{"v": 2, "id": "j-m1x8-3-a9f2c1", "type": "ffmpeg-op",
 "payload": {"url": "https://…", "op": "dash-merge", "options": {…}}}
```

Respuesta:

```json
{"v": 2, "id": "j-m1x8-3-a9f2c1", "type": "ffmpeg-progress",
 "payload": {"phase": "process", "progress": 42}}
```

- `v` — versión del protocolo. La respuesta usa SIEMPRE la versión de la petición.
- `id` — correlación. El host lo devuelve en **todos** los mensajes de esa
  petición, incluidos los asíncronos de ffmpeg, yt-dlp y el recorder.
- `type` — mismo vocabulario que v1.
- `payload` — los campos que en v1 iban en la raíz.

## Handshake

1. El cliente manda `{"type": "ping"}` **siempre en v1 plano**.
2. El host responde en v1 e incluye `protocols: [1, 2]` y `protocol: 2`.
3. Si la respuesta trae 2 en `protocols`, el cliente usa v2 a partir de ahí.
4. Si no lo trae, el host es viejo y se sigue en v1.

Es **aditivo** a propósito: un cliente v1 ve campos que no conoce y los ignora.
Por eso el ping es la única petición que no necesita envelope para detectar si
el host lo soporta.

`protocol: 2` sin `protocols` NO cuenta como capacidad: la versión tiene que
probarse, no declararse. Un host no puede declararse v2 sin confirmar que sigue
hablando v1.

## Matriz de compatibilidad

| Cliente | Host | Resultado |
|---|---|---|
| v1 | nuevo | Funciona. El pong trae campos extra que v1 ignora. |
| v2 | nuevo | Funciona. Envelope + `id` en todas las respuestas. |
| v2 | viejo | Funciona. Se queda en v1 tras el handshake. |
| v1 | viejo | Funciona. Sin cambios. |

Nadie necesita reinstalar nada en ningún caso.

## Por qué `id`

Sin correlación, dos descargas concurrentes emiten mensajes indistinguibles y el
panel los atribuía al trabajo equivocado. Casos reales que ya estaban en el
código y que el `id` elimina:

- `panel.js` manejaba `ffmpeg-progress` en dos sitios. El progreso del ensamblado
  de una grabación escribía «Ensamblando grabación… 40 %» sobre una descarga en
  curso, y al revés: si el estado ya había vuelto a `idle`, el progreso de la
  grabación caía en el diálogo «Descargando a tu PC…».
- Dos descargas con `yt-dlp` simultáneas: el segundo `done` pisaba el estado del
  primero.
- `error` es un tipo genérico compartido por yt-dlp, «URL vacía» y los errores de
  decodificación JSON del propio protocolo. Los tres se pintaban como «yt-dlp: …».

Con `id`, la atribución es un hecho del mensaje y no una conjetura del panel.

## Dónde se resuelve la versión

**En el borde, una sola vez.**

- Rust: `Incoming::parse` normaliza cualquier forma a `Incoming { version, id,
  kind, payload }`. `main.rs` lee los argumentos con `incoming.arg*()`.
- El contexto de respuesta viaja **dentro del `MessageSender`**, no por los
  argumentos de cada función. `ytdl`, `ffmpeg_ops`, `recorder` y `tools` tienen
  ~30 llamadas a `send()` y **ninguna ha cambiado**: `sender.for_request(&incoming)`
  devuelve un sender que envuelve automáticamente. Esa es la diferencia entre
  cambiar un contrato y reescribir cuatro módulos.
- JS: `src/shared/native-protocol.js` desenvuelve una vez en el service worker.
  El panel sigue viendo `{ type, ...campos }` más un `id`, exactamente donde los
  buscaba antes.

Los módulos de dominio no saben que existe una v2. `recorder::append` sigue
recibiendo `&str`, no `&Incoming`.

## Añadir un mensaje nuevo

1. Añadir el `type` al `match` de `main.rs`.
2. Leer los argumentos con `incoming.arg_string()` / `arg_value()`.
3. **Responder con `sender`** (el que lleva contexto), nunca con `base_sender`:
   si se responde con el base, el mensaje sale en v1 plano y un cliente v2 recibe
   algo que no entiende.
4. Añadir el `type` a los terminales si cierra el job.
5. Añadir el caso al `contract.mjs`.

Un mensaje nuevo **no requiere** subir la versión: v2 es un envelope, no una
colección de tipos versionados. La versión sube cuando cambie la FORMA.

## Tests

| Suite | Qué fija | Por qué |
|---|---|---|
| `cargo test protocol` (17) | Parseo v1/v2, envoltura, `id`, handshake, round-trip | Lógica pura del host. |
| `tests/unit/native-protocol.test.js` (21) | Negociación y desenvoltura del cliente | Módulo puro, corre en Node sin Chrome. |
| `npm run test:contract` (11) | El binario real cumple lo que el cliente espera | Habla con el `.exe`. Una reimplementación en JS del protocolo comprobaría que el JS coincide consigo mismo. |
| `npm run test:firefox` | La build de Gecko arranca | El linter no ejecuta nada. |

```bash
npm run host:build        # el contrato necesita el binario release
npm run test:contract
```

## Pendiente

El envelope no arregla el modelo de ejecución. Los jobs siguen viviendo en el heap
del panel (`panel.js`, `job.chunks[index] = buf`), y el service worker sigue
tratando la memoria como persistente. Eso es trabajo aparte, y es lo que hace
necesario este `id`: sin correlación no se puede mover un job al service worker
sin que sus mensajes dejen de poder atribuirse.
