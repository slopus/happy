//! The Socket.IO side of one Engine.IO session: socket.io 4.8's `Client`
//! (decoder, namespace connect, connect timeout), `Namespace#_add` with the auth
//! middleware of `socket.ts`, and the connection / disconnect handlers.

use crate::engine::{Msg, Session, State};
use crate::events::{ConnType, Filter, SocketHandle};
use crate::handlers::{self, Ack, Arg};
use crate::js;
use crate::socket::{self, Packet};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(20_000);

#[derive(Default)]
pub(crate) struct SioState {
    pub destroyed: bool,
    pub socket: Option<Arc<SocketHandle>>,
    pub connect_timeout_at: Option<Instant>,
    recon: Option<Recon>,
    /// CONNECT packets whose middleware completes after the current inbound batch.
    pending_connects: Vec<Value>,
}

/// `BinaryReconstructor`.
struct Recon {
    packet: Packet,
    attachments: f64,
    buffers: Vec<Vec<u8>>,
}

struct AuthOk {
    user_id: String,
    client_type: Option<Value>,
    session_id: Option<Value>,
    machine_id: Option<Value>,
    happy_client: Option<String>,
}

impl Session {
    pub(crate) fn sio_open(&mut self) {
        self.sio.connect_timeout_at = Some(Instant::now() + CONNECT_TIMEOUT);
    }

    pub(crate) fn sio_connect_timeout(&mut self) {
        if self.sio.socket.is_none() {
            self.sio_client_close();
        }
    }

    /// `client._packet` / `socket.packet`: dropped unless the engine is open.
    pub(crate) fn sio_write(&mut self, text: String, atts: Vec<Vec<u8>>) {
        if self.state == State::Open {
            let _ = self.tx.send(crate::engine::Cmd::Emit(text, atts));
        }
    }

    pub(crate) fn sio_ondata(&mut self, m: Msg) {
        if self.sio.destroyed {
            return;
        }
        let decoded: Result<Option<Packet>, String> = match m {
            Msg::Text(s) => {
                if self.sio.recon.is_some() {
                    Err("got plaintext data when reconstructing a packet".into())
                } else {
                    match socket::decode_string(&s) {
                        Ok(mut p) if p.ty == socket::BINARY_EVENT || p.ty == socket::BINARY_ACK => {
                            p.ty = if p.ty == socket::BINARY_EVENT { socket::EVENT } else { socket::ACK };
                            let n = p.attachments;
                            self.sio.recon = Some(Recon { packet: p.clone(), attachments: n, buffers: Vec::new() });
                            // Zero attachments: emitted now, but the reconstructor stays armed.
                            Ok(if n == 0.0 { Some(p) } else { None })
                        }
                        Ok(p) => Ok(Some(p)),
                        Err(e) => Err(e),
                    }
                }
            }
            Msg::Binary(b) => match &mut self.sio.recon {
                None => Err("got binary data when not reconstructing a packet".into()),
                Some(r) => {
                    r.buffers.push(b);
                    if r.buffers.len() as f64 == r.attachments {
                        let r = self.sio.recon.take().unwrap();
                        let mut p = r.packet;
                        match p.data.take().map(|d| socket::reconstruct(d, &r.buffers)).transpose() {
                            Ok(d) => {
                                p.data = d;
                                Ok(Some(p))
                            }
                            Err(e) => Err(e),
                        }
                    } else {
                        Ok(None)
                    }
                }
            },
            Msg::Empty => Err("Unknown type: undefined".into()),
        };
        match decoded {
            Ok(Some(p)) => self.sio_ondecoded(p),
            Ok(None) => {}
            Err(e) => {
                tracing::debug!(module = "websocket", "socket.io protocol error: {}", e);
                self.close(); // client.onerror → conn.close()
            }
        }
    }

    fn sio_ondecoded(&mut self, p: Packet) {
        let current = if p.nsp == "/" { self.sio.socket.clone() } else { None };
        match current {
            None if p.ty == socket::CONNECT => {
                let auth = p.data.clone().unwrap_or_else(|| Value::Object(Map::new()));
                if p.nsp != "/" {
                    let (t, a) = socket::encode(socket::CONNECT_ERROR, &p.nsp, None, Some(&json!({"message": "Invalid namespace"})));
                    self.sio_write(t, a);
                } else {
                    self.sio.pending_connects.push(auth);
                }
            }
            Some(s) if p.ty != socket::CONNECT && p.ty != socket::CONNECT_ERROR => self.socket_onpacket(s, p),
            _ => self.sio_client_close(),
        }
    }

    /// `client.close()`.
    fn sio_client_close(&mut self) {
        if self.state == State::Open {
            self.close();
            self.sio_onclose("forced server close");
        }
    }

    /// `client.onclose(reason)`.
    pub(crate) fn sio_onclose(&mut self, reason: &str) {
        if self.sio.destroyed {
            return;
        }
        self.sio.destroyed = true;
        self.sio.connect_timeout_at = None;
        self.sio.recon = None;
        self.sio.pending_connects.clear();
        if let Some(s) = self.sio.socket.take() {
            self.socket_onclose(&s, reason);
        }
    }

    /// Namespace middleware results, after the batch that carried the CONNECT.
    pub(crate) fn sio_flush_connects(&mut self) {
        if self.sio.pending_connects.is_empty() {
            return;
        }
        for auth in std::mem::take(&mut self.sio.pending_connects) {
            if self.sio.destroyed || self.state != State::Open || self.sio.socket.is_some() {
                continue;
            }
            match self.authenticate(&auth) {
                Err(msg) => {
                    let (t, a) = socket::encode(socket::CONNECT_ERROR, "/", None, Some(&json!({"message": msg})));
                    self.sio_write(t, a);
                }
                Ok(ok) => self.sio_do_connect(ok, &auth),
            }
        }
    }

    /// The `io.use(...)` middleware of `socket.ts`.
    fn authenticate(&self, auth: &Value) -> Result<AuthOk, &'static str> {
        let get = |k: &str| auth.get(k).filter(|v| !v.is_null()).cloned();
        let token = auth.get("token");
        let client_type = auth.get("clientType");
        let session_id = auth.get("sessionId");
        let machine_id = auth.get("machineId");
        if !js::truthy(token) {
            return Err("Missing authentication token");
        }
        let ct = client_type.and_then(|v| v.as_str());
        if ct == Some("session-scoped") && !js::truthy(session_id) {
            return Err("Session ID required for session-scoped clients");
        }
        if ct == Some("machine-scoped") && !js::truthy(machine_id) {
            return Err("Machine ID required for machine-scoped clients");
        }
        let user_id = match token {
            Some(Value::String(t)) => self.app.auth.verify_token(t),
            _ => None,
        };
        let Some(user_id) = user_id else { return Err("Invalid authentication token") };
        let happy_client = match auth.get("happyClient") {
            v if js::truthy(v) => Some(js::to_js_string(v.unwrap())),
            _ => self.happy_client_header.clone().filter(|s| !s.is_empty()),
        };
        Ok(AuthOk { user_id, client_type: get("clientType"), session_id: get("sessionId"), machine_id: get("machineId"), happy_client })
    }

    fn sio_do_connect(&mut self, a: AuthOk, auth: &Value) {
        let app = self.app.clone();
        let sid = crate::util::base64id();
        let ct = a.client_type.as_ref().and_then(|v| v.as_str());
        let conn_type = if ct == Some("session-scoped") && js::truthy(a.session_id.as_ref()) {
            ConnType::SessionScoped
        } else if ct == Some("machine-scoped") && js::truthy(a.machine_id.as_ref()) {
            ConnType::MachineScoped
        } else {
            ConnType::UserScoped
        };
        let room_key = |v: &Option<Value>| v.as_ref().map(js::to_js_string);
        let labels = crate::metrics::client_labels(a.happy_client.as_deref());
        let app_state = match auth.get("appState") {
            v if js::truthy(v) => Some(if v == Some(&Value::String("active".into())) { "active" } else { "background" }),
            _ => None,
        };
        let s = Arc::new(SocketHandle {
            id: sid.clone(),
            user_id: a.user_id.clone(),
            conn_type,
            session_id: room_key(&a.session_id),
            machine_id: room_key(&a.machine_id),
            machine_id_value: a.machine_id.clone().unwrap_or(Value::Null),
            happy_client: a.happy_client.clone(),
            labels: labels.clone(),
            client_type_raw: ct.map(|s| s.to_string()),
            app_state: parking_lot::Mutex::new(app_state),
            tx: self.tx.clone(),
            rooms: Default::default(),
            acks: Default::default(),
            queues: Default::default(),
        });
        self.sio.socket = Some(s.clone());
        self.sio.connect_timeout_at = None;
        let (t, at) = socket::encode(socket::CONNECT, "/", None, Some(&json!({"sid": sid})));
        self.sio_write(t, at);

        // io.on("connection")
        let uid = &a.user_id;
        app.hub.add_socket(s.clone());
        app.hub.join(&s, &format!("user:{}", uid));
        match conn_type {
            ConnType::UserScoped => app.hub.join(&s, &format!("user:{}:user-scoped", uid)),
            ConnType::SessionScoped => app.hub.join(&s, &format!("user:{}:session:{}", uid, s.session_id.as_deref().unwrap_or(""))),
            ConnType::MachineScoped => app.hub.join(&s, &format!("user:{}:machine:{}", uid, s.machine_id.as_deref().unwrap_or(""))),
        }
        app.metrics.websocket_connections.with_label_values(&[conn_type.as_str(), &labels.0, &labels.1]).inc();
        if conn_type == ConnType::MachineScoped {
            let e = crate::events::machine_activity(&s.machine_id_value, true, crate::util::now_ms() as f64);
            app.hub.emit_ephemeral(uid, e, Filter::UserScopedOnly);
        }
        tracing::info!(
            module = "websocket",
            "Token verified: {}, clientType: {}, client: {}, sessionId: {}, machineId: {}, socketId: {}",
            uid,
            ct.unwrap_or("user-scoped"),
            labels.0,
            s.session_id.as_deref().unwrap_or("none"),
            s.machine_id.as_deref().unwrap_or("none"),
            sid
        );
    }

    fn socket_onpacket(&mut self, s: Arc<SocketHandle>, p: Packet) {
        match p.ty {
            socket::EVENT => {
                let mut items = match p.data {
                    Some(Value::Array(a)) => a,
                    _ => Vec::new(),
                };
                if items.is_empty() {
                    return;
                }
                let name = items.remove(0);
                let mut args: Vec<Arg> = items.into_iter().map(Arg::Val).collect();
                if let Some(id) = p.id {
                    args.push(Arg::Ack(Ack::new(self.tx.clone(), id)));
                }
                if s.is_closed() {
                    return;
                }
                match name {
                    Value::String(n) => handlers::dispatch(&self.app, &s, &n, args),
                    _ => {} // numeric event names have no listeners
                }
            }
            socket::ACK => {
                let Some(id) = p.id.filter(|i| *i >= 0.0 && i.fract() == 0.0 && *i < 9.0e15) else { return };
                let args = match p.data {
                    Some(Value::Array(a)) => a,
                    _ => Vec::new(),
                };
                if let Some(tx) = s.acks.lock().remove(&(id as u64)) {
                    let _ = tx.send(args);
                }
            }
            socket::DISCONNECT => {
                if self.sio.socket.as_ref().is_some_and(|x| Arc::ptr_eq(x, &s)) {
                    self.sio.socket = None;
                }
                self.socket_onclose(&s, "client namespace disconnect");
            }
            _ => {}
        }
    }

    /// `socket._onclose`: leave every room, then the `disconnect` handler of `socket.ts`.
    fn socket_onclose(&mut self, s: &Arc<SocketHandle>, _reason: &str) {
        if s.is_closed() {
            return;
        }
        let app = &self.app;
        app.hub.remove_socket(&s.id);
        app.metrics.websocket_events.with_label_values(&["disconnect", &s.labels.0, &s.labels.1]).inc();
        app.metrics.websocket_connections.with_label_values(&[s.conn_type.as_str(), &s.labels.0, &s.labels.1]).dec();
        tracing::info!(module = "websocket", "User disconnected: {}", s.user_id);
        if s.conn_type == ConnType::MachineScoped {
            let e = crate::events::machine_activity(&s.machine_id_value, false, crate::util::now_ms() as f64);
            app.hub.emit_ephemeral(&s.user_id, e, Filter::UserScopedOnly);
        }
    }
}
