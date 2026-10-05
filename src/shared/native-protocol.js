// src/shared/native-protocol.js - Cliente del protocolo del host nativo.
//
// POR QUÉ ESTO EXISTE Y POR QUÉ NO ESTÁ EN background.js
// -------------------------------------------------------
// El contrato con `operant-host.exe` tiene dos formas vivas a la vez:
//
//   v1  {"type":"ytdl","url":"..."}                        (objeto plano)
//   v2  {"v":2,"id":"…","type":"ytdl","payload":{…}}       (envelope)
//
// v2 añade el `id` de correlación, sin el cual dos descargas concurrentes
// emiten `progress`/`done` indistinguibles y el panel atribuye el progreso al
// trabajo equivocado (ocurre en `panel.js`, donde `ffmpeg-progress` está
// manejado dos veces).
//
// La migración no puede romper a nadie, así que el handshake es ADITIVO y se
// hace siempre en v1 plano:
//
//   1. el cliente manda `{"type":"ping"}`;
//   2. si la respuesta trae `protocols` con 2, se habla v2 en adelante;
//   3. si no lo trae, el host es viejo: se sigue en v1 y todo funciona igual.
//
// Un host nuevo contesta a un ping v1 con un pong v1 que incluye `protocols`.
// Un cliente v1 ignora ese campo y sigue como antes. Nadie necesita reinstalar
// nada.
//
// Todo lo de este módulo es PURO: no toca `chrome.*`, así que se testea en Node
// sin navegador, que es la única forma de que un test de protocolo no sea una
// tautología.

export const PROTOCOL_V1 = 1;
export const PROTOCOL_V2 = 2;

/**
 * Envuelve una petición en v2.
 * @param {string} id correlación; la devuelve el host en cada mensaje de esa petición
 * @param {string} type
 * @param {object} payload
 */
export function wrapV2(id, type, payload) {
  return { v: PROTOCOL_V2, id, type, payload: payload || {} };
}

/**
 * Decide la forma de una petición según lo que el host déclaré soportar.
 *
 * @param {string} type
 * @param {object} args
 * @param {number|null|undefined} protocol `null` = aún no negociado (solo v1)
 * @param {string|null} id
 */
export function buildRequest(type, args, protocol, id) {
  const payload = { ...(args || {}) };
  if (protocol >= PROTOCOL_V2 && id) return wrapV2(id, type, payload);
  // v1: los campos van en la raíz, junto a `type`.
  return { type, ...payload };
}

/**
 * Lee la respuesta del host y la normaliza a la misma forma que antes usaba el
 * panel: `{ type, ...campos }`, más `id` y `protocol` cuando vienen.
 *
 * Un cliente v2 tiene que entender también las respuestas planas de un host
 * viejo, y un cliente v1 tiene que ignorar con elegancia un envelope (por si un
 * host futuro decide responder siempre en v2). Ambas cosas se resuelven aquí,
 * en un solo sitio, en vez de en cada `if (msg.type === …)` del panel.
 *
 * @returns {{type:string, id:string|null, protocol:number, fields:object}}
 */
export function parseResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return { type: "", id: null, protocol: PROTOCOL_V1, fields: {} };
  }
  const isV2 = raw.payload && typeof raw.payload === "object" && typeof raw.v === "number";
  if (!isV2) {
    const { type, ...fields } = raw;
    return {
      type: typeof type === "string" ? type : "",
      id: typeof raw.id === "string" ? raw.id : null,
      protocol: PROTOCOL_V1,
      fields,
    };
  }
  const { type, payload } = raw;
  return {
    type: typeof type === "string" ? type : "",
    id: typeof raw.id === "string" ? raw.id : null,
    protocol: raw.v,
    fields: { ...payload },
  };
}

/**
 * Extrae las capacidades del host de un `pong`.
 *
 * Solo se mira `protocols`: es el campo que un host viejo no envía y cuya
 * ausencia significa exactamente "habla v1". Un `protocol` sin `protocols` no
 * cuenta como capacidad, para que un host futuro no pueda declararse v2 sin
 * supporting v1.
 *
 * @returns {number} PROTOCOL_V2 si el host declara soportarla; PROTOCOL_V1 si no.
 */
export function negotiate(fields) {
  const list = fields && fields.protocols;
  if (Array.isArray(list) && list.includes(PROTOCOL_V2)) return PROTOCOL_V2;
  return PROTOCOL_V1;
}

/**
 * `id` de correlación para una petición nueva.
 *
 * No usa `crypto.randomUUID()` a ciegas: el host es un proceso Windows que se
 * registra desde 2019 y `randomUUID` no está en todos los contextos de service
 * worker. La combinación de `Date.now()` con un contador y un resto aleatorio
 * basta: solo tiene que ser único entre peticiones VIVAS, no criptográficamente
 * impredecible, y por eso no se usa para nada que sea secreto.
 */
let seq = 0;
export function nextRequestId(prefix = "j") {
  seq += 1;
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${rand}`;
}

/**
 * ¿Este mensaje es la respuesta terminal de su petición?
 *
 * Un `done`/`error` cierra el job; un `progress` no. El panel lo usa para no
 * dejar una barra de progreso girando para siempre cuando el host responde con
 * algo que no reconoce.
 */
const TERMINAL = new Set([
  "done",
  "error",
  "ffmpeg-done",
  "ffmpeg-error",
  "formats-error",
  "tool-done",
  "tool-error",
  "tool-uninstalled",
  "rec-beginned",
  "rec-appended",
  "rec-cancelled",
  "rec-error",
]);

export function isTerminal(type) {
  return TERMINAL.has(type);
}