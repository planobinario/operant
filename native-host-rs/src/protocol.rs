use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

/// Versiones de protocolo que este host entiende y habla.
///
/// v1 (histórico) era un objeto plano: `{"type":"ytdl","url":"..."}`. Se mantiene
/// porque hay extensiones ya instaladas que no saben hablar otra cosa, y porque
/// el coste de romperlas es un host que no funciona sin diagnóstico.
///
/// v2 envuelve el payload y añade un `id` de correlación:
///
/// ```json
/// {"v":2,"id":"c1f…","type":"ffmpeg-progress","payload":{"phase":"process","progress":42}}
/// ```
///
/// El `id` es lo que permite saber a qué petición pertenece un mensaje asíncrono.
/// Sin él, dos descargas concurrentes emiten `progress`/`done` indistinguibles y
/// el panel los atribuía al trabajo equivocado (ver docs/PROTOCOL-NATIVO.md).
pub const PROTOCOL_V1: u8 = 1;
pub const PROTOCOL_V2: u8 = 2;
pub const PROTOCOLS: [u8; 2] = [PROTOCOL_V1, PROTOCOL_V2];

/// Contexto de respuesta heredado de una petición.
///
/// Viaja dentro del [`MessageSender`] en vez de por los argumentos de cada
/// función: `ytdl`, `ffmpeg_ops`, `recorder` y `tools` tienen ~30 llamadas a
/// `send()` repartidas, y todas deben emitir en la versión que pidió el cliente
/// y con su `id`. Con el contexto en el sender, ninguna de esas funciones
/// cambia: es la diferencia entre un cambio de contrato y unaattributes refactor.
#[derive(Clone, Debug, PartialEq)]
pub struct ReplyCtx {
    pub version: u8,
    pub id: Option<String>,
}

/// Petición normalizada, independiente de la forma en que llegó.
#[derive(Clone, Debug, PartialEq)]
pub struct Incoming {
    pub version: u8,
    pub id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

impl Incoming {
    /// Normaliza un mensaje entrante a v1 o v2.
    ///
    /// La detección NO es "si tiene `v`". Un mensaje v2 siempre trae `payload`,
    /// y ese es el rasgo que lo define. Un cliente que mande `v` sin `payload`
    /// (o al revés) es un bug de cliente, no algo que haya que adivinar: se
    /// acepta como v1 plano, que es lo que haría un host antiguo, y el campo
    /// desconocido se ignora igual que haría serde.
    pub fn parse(value: &Value) -> Incoming {
        let obj = match value.as_object() {
            Some(o) => o,
            None => {
                return Incoming {
                    version: PROTOCOL_V1,
                    id: None,
                    kind: String::new(),
                    payload: value.clone(),
                }
            }
        };

        let is_v2 = obj.contains_key("payload") && obj.contains_key("v");
        if !is_v2 {
            let mut payload = obj.clone();
            let kind = payload
                .remove("type")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default();
            return Incoming {
                version: PROTOCOL_V1,
                id: None,
                kind,
                payload: Value::Object(payload),
            };
        }

        let version = obj.get("v").and_then(|v| v.as_u64()).unwrap_or(2) as u8;
        let version = if version >= PROTOCOL_V2 {
            version
        } else {
            PROTOCOL_V2
        };
        let kind = obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let payload = obj.get("payload").cloned().unwrap_or_else(|| json!({}));
        Incoming {
            version,
            id: obj
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            kind,
            payload,
        }
    }

    /// Lectura de un argumento del payload, sin depender de la versión.
    ///
    /// Todo el acceso a argumentos pasa por aquí. Antes, `main.rs` leía
    /// `msg.get("url")` sobre el objeto plano; con v2 esos campos viven en
    /// `payload`, y leerlos en la raíz daría `""` en silencio y un
    /// "URL vacía." que no explica nada.
    pub fn arg(&self, name: &str) -> Option<&str> {
        self.payload.get(name).and_then(|v| v.as_str())
    }

    pub fn arg_string(&self, name: &str) -> String {
        self.arg(name).unwrap_or_default().to_string()
    }

    pub fn arg_value(&self, name: &str) -> Value {
        self.payload.get(name).cloned().unwrap_or_else(|| json!({}))
    }

    pub fn ctx(&self) -> ReplyCtx {
        ReplyCtx {
            version: self.version,
            id: self.id.clone(),
        }
    }
}

#[derive(Clone)]
pub struct MessageSender {
    stdout: Arc<Mutex<io::Stdout>>,
    ctx: Option<Arc<ReplyCtx>>,
}

impl MessageSender {
    pub fn new() -> Self {
        Self {
            stdout: Arc::new(Mutex::new(io::stdout())),
            ctx: None,
        }
    }

    /// Sender que responde en la versión de `request`, con su `id`.
    ///
    /// Se clona para el hilo que atiende la petición, así que todos los mensajes
    /// que ese hilo emita (incluidos los asíncronos posteriores) salen
    /// correlacionados sin tocar el código que los emite.
    pub fn for_request(&self, request: &Incoming) -> Self {
        Self {
            stdout: self.stdout.clone(),
            ctx: Some(Arc::new(request.ctx())),
        }
    }

    /// Envía un mensaje en la forma que corresponda al contexto.
    ///
    /// Sin contexto (o con un cliente v1) sale un objeto plano, idéntico al de
    /// siempre. Con un cliente v2 se envuelve, moviendo `type` al nivel superior
    /// y el resto de campos a `payload`.
    pub fn send<T: Serialize>(&self, msg: &T) -> io::Result<()> {
        let value =
            serde_json::to_value(msg).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.send_value(value)
    }

    pub fn send_value(&self, value: Value) -> io::Result<()> {
        let value = self.wrap(value);
        let payload = serde_json::to_vec(&value)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let len = payload.len() as u32;
        let mut out = self.stdout.lock().unwrap();
        out.write_all(&len.to_le_bytes())?;
        out.write_all(&payload)?;
        out.flush()?;
        Ok(())
    }

    /// Aplica el envelope. Aislado para poder testearlo sin stdout.
    fn wrap(&self, value: Value) -> Value {
        let Some(ctx) = &self.ctx else {
            return value;
        };
        if ctx.version < PROTOCOL_V2 {
            return value;
        }
        let Value::Object(obj) = value else {
            // Un mensaje que no es objeto no tiene `type` que envolver; enviarlo
            // plano es mejor que descartarlo.
            return value;
        };
        let mut payload = obj.clone();
        let kind = payload
            .remove("type")
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let mut env = Map::new();
        env.insert("v".to_string(), json!(PROTOCOL_V2));
        if let Some(id) = &ctx.id {
            env.insert("id".to_string(), json!(id));
        }
        env.insert("type".to_string(), json!(kind));
        env.insert("payload".to_string(), Value::Object(payload));
        Value::Object(env)
    }
}

impl Default for MessageSender {
    fn default() -> Self {
        Self::new()
    }
}

pub fn read_message<T: DeserializeOwned>() -> io::Result<Option<T>> {
    let mut len_buf = [0u8; 4];
    let mut stdin = io::stdin().lock();
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let length = u32::from_le_bytes(len_buf) as usize;
    if length == 0 || length > 10 * 1024 * 1024 {
        return Ok(None);
    }
    let mut buf = vec![0u8; length];
    stdin.read_exact(&mut buf)?;
    match serde_json::from_slice(&buf) {
        Ok(val) => Ok(Some(val)),
        Err(err) => {
            eprintln!("[protocol] JSON decode error: {}", err);
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sender_for(version: u8, id: Option<&str>) -> MessageSender {
        MessageSender {
            stdout: Arc::new(Mutex::new(io::stdout())),
            ctx: Some(Arc::new(ReplyCtx {
                version,
                id: id.map(|s| s.to_string()),
            })),
        }
    }

    // --- parseo: v1 plano (el contrato de siempre) ---

    #[test]
    fn v1_plano_se_normaliza() {
        let r = Incoming::parse(&json!({ "type": "ytdl", "url": "https://x/y", "format": "b" }));
        assert_eq!(r.version, PROTOCOL_V1);
        assert_eq!(r.kind, "ytdl");
        assert_eq!(r.id, None);
        assert_eq!(r.arg_string("url"), "https://x/y");
        assert_eq!(r.arg_string("format"), "b");
    }

    #[test]
    fn v1_sin_type_no_revienta() {
        let r = Incoming::parse(&json!({ "url": "x" }));
        assert_eq!(r.kind, "");
        assert_eq!(r.version, PROTOCOL_V1);
    }

    #[test]
    fn no_objeto_no_revienta() {
        // Un array o un numero llegan malformados desde un cliente buggy. Antes
        // `msg.get("type")` sobre un no-objeto devolivia None y seguia; aqui se
        // conserva ese comportamiento en vez de entrar en panic.
        for bad in [json!(5), json!("hola"), json!([1, 2, 3]), json!(null)] {
            let r = Incoming::parse(&bad);
            assert_eq!(r.version, PROTOCOL_V1);
            assert_eq!(r.kind, "");
        }
    }

    // --- parseo: v2 envuelto ---

    #[test]
    fn v2_se_normaliza_con_id() {
        let r = Incoming::parse(&json!({
            "v": 2, "id": "abc", "type": "ffmpeg-op",
            "payload": { "url": "https://x/y", "op": "merge" }
        }));
        assert_eq!(r.version, PROTOCOL_V2);
        assert_eq!(r.kind, "ffmpeg-op");
        assert_eq!(r.id.as_deref(), Some("abc"));
        // Los argumentos se leen del payload, no de la raiz.
        assert_eq!(r.arg_string("url"), "https://x/y");
        assert_eq!(r.arg_string("op"), "merge");
    }

    #[test]
    fn v2_vieja_se_degrada_a_v1() {
        // Cliente v2 estricto hablando con un host v1: se habla v1.
        let r = Incoming::parse(&json!({ "v": 2, "id": "abc", "type": "ping" }));
        assert_eq!(r.version, PROTOCOL_V1);
        assert_eq!(r.kind, "ping");
        assert_eq!(
            r.id, None,
            "en v1 no hay correlacion: no se puede inventar un id"
        );
    }

    #[test]
    fn payload_ausente_en_un_mensaje_marcado_v2_es_v1() {
        // `v` sin `payload` no define un envelope. Se trata como plano, que es
        // lo que haria un host antiguo, en vez de perder los argumentos.
        let r = Incoming::parse(&json!({ "v": 2, "id": "abc", "type": "ytdl", "url": "u" }));
        assert_eq!(r.version, PROTOCOL_V1);
        assert_eq!(r.arg_string("url"), "u");
    }

    #[test]
    fn un_campo_llamado_type_dentro_del_payload_no_es_el_tipo() {
        // El envelope define el tipo arriba; un `type` dentro del payload es un
        // dato del cliente y no debe promover el mensaje a v2.
        let r = Incoming::parse(&json!({
            "v": 2, "payload": { "type": "audio" }, "type": "rec-append"
        }));
        assert_eq!(r.kind, "rec-append");
        assert_eq!(r.arg_string("type"), "audio");
    }

    // --- envoltura de respuestas ---

    #[test]
    fn sin_contexto_se_emite_plano() {
        let s = MessageSender::new();
        let out = s.wrap(json!({ "type": "pong", "tools": {} }));
        assert_eq!(out, json!({ "type": "pong", "tools": {} }));
    }

    #[test]
    fn contexto_v1_se_emite_plano() {
        let s = sender_for(PROTOCOL_V1, Some("abc"));
        let out = s.wrap(json!({ "type": "progress", "line": "x" }));
        assert_eq!(
            out,
            json!({ "type": "progress", "line": "x" }),
            "un cliente v1 no debe recibir campos que no conoce"
        );
    }

    #[test]
    fn contexto_v2_envuelve_y_mueve_type() {
        let s = sender_for(PROTOCOL_V2, Some("job-7"));
        let out = s.wrap(json!({ "type": "ffmpeg-progress", "phase": "process", "progress": 42 }));
        assert_eq!(out["v"], json!(2));
        assert_eq!(out["id"], json!("job-7"));
        assert_eq!(out["type"], json!("ffmpeg-progress"));
        assert_eq!(out["payload"]["phase"], json!("process"));
        assert_eq!(out["payload"]["progress"], json!(42));
        assert!(
            out["payload"].get("type").is_none(),
            "type no debe quedar duplicado dentro del payload"
        );
    }

    #[test]
    fn contexto_v2_sin_id_sigue_siendo_valido() {
        // El id es opcional: una peticion sin correlacion (por ejemplo una
        // notificacion) no puede generar uno, y eso no debe romper el envelope.
        let s = sender_for(PROTOCOL_V2, None);
        let out = s.wrap(json!({ "type": "tools-status" }));
        assert_eq!(out["v"], json!(2));
        assert!(out.get("id").is_none());
        assert_eq!(out["type"], json!("tools-status"));
    }

    #[test]
    fn el_envolvente_agrega_los_campos_al_payload_y_conserva_el_resto() {
        let s = sender_for(PROTOCOL_V2, Some("i"));
        let out = s.wrap(json!({ "type": "done", "folder": "D", "name": "n", "size": 3 }));
        let p = &out["payload"];
        assert_eq!(p.as_object().unwrap().len(), 3, "folder + name + size");
        assert_eq!(p["folder"], json!("D"));
        assert_eq!(p["name"], json!("n"));
        assert_eq!(p["size"], json!(3));
    }

    // --- ida y vuelta: lo que sale se puede volver a entrar ---

    #[test]
    fn round_trip_de_un_mensaje_v2() {
        let s = sender_for(PROTOCOL_V2, Some("abc"));
        let sent = s.wrap(json!({ "type": "ffmpeg-done", "name": "x.mp4" }));
        let back = Incoming::parse(&sent);
        assert_eq!(back.version, PROTOCOL_V2);
        assert_eq!(back.kind, "ffmpeg-done");
        assert_eq!(back.id.as_deref(), Some("abc"));
        assert_eq!(back.arg_string("name"), "x.mp4");
    }

    #[test]
    fn round_trip_de_un_mensaje_v1() {
        let s = sender_for(PROTOCOL_V1, None);
        let sent = s.wrap(json!({ "type": "pong", "tools": { "ffmpeg": {} } }));
        let back = Incoming::parse(&sent);
        assert_eq!(back.version, PROTOCOL_V1);
        assert_eq!(back.kind, "pong");
        assert!(back.arg_value("tools").is_object());
    }

    // --- handshake ---

    #[test]
    fn los_protocolos_declarados_incluyen_v1_para_el_cliente_viejo() {
        // El host declara ambas versiones. Un cliente que solo entienda v1 ve
        // un array que no conoce y lo ignora: por eso el handshake es aditivo.
        assert_eq!(PROTOCOLS, [1, 2]);
    }

    // --- contexto ---

    #[test]
    fn el_contexto_conserva_version_e_id() {
        let r = Incoming::parse(&json!({ "v": 2, "id": "z", "type": "ping", "payload": {} }));
        assert_eq!(
            r.ctx(),
            ReplyCtx {
                version: 2,
                id: Some("z".into())
            }
        );
    }

    #[test]
    fn argumentos_ausentes_devuelven_valores_neutros_y_no_panan() {
        let r = Incoming::parse(&json!({ "type": "ytdl" }));
        assert_eq!(r.arg_string("url"), "");
        assert!(r.arg("url").is_none());
        assert_eq!(r.arg_value("options"), json!({}));
    }
}
