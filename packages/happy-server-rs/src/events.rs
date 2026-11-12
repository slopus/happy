//! In-memory replacement for `eventRouter.ts` + Socket.IO rooms (single process).
//! Builders produce the exact payload shapes and key orders of the TS builders.

use crate::js;
use crate::util::{b64_encode, naive_to_ms, now_ms, random_key_naked};
use dashmap::DashMap;
use futures_util::future::BoxFuture;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConnType {
    UserScoped,
    SessionScoped,
    MachineScoped,
}

impl ConnType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnType::UserScoped => "user-scoped",
            ConnType::SessionScoped => "session-scoped",
            ConnType::MachineScoped => "machine-scoped",
        }
    }
}

/// One connected Socket.IO socket (namespace `/`) as handlers and the hub see it.
pub struct SocketHandle {
    pub id: String,
    pub user_id: String,
    pub conn_type: ConnType,
    /// Room keys (`String(value)` of the handshake values).
    pub session_id: Option<String>,
    pub machine_id: Option<String>,
    /// The handshake `machineId` as sent (machine-activity ephemerals echo it).
    pub machine_id_value: Value,
    pub happy_client: Option<String>,
    /// `(client, client_type)` metric labels.
    pub labels: (String, String),
    /// `socket.data.clientType` when it is a string.
    pub client_type_raw: Option<String>,
    pub app_state: Mutex<Option<&'static str>>,
    /// The Engine.IO session actor that owns the connection.
    pub tx: mpsc::UnboundedSender<crate::engine::Cmd>,
    /// Rooms joined, plus a closed flag; the lock orders join/leave against removal.
    pub rooms: Mutex<SocketRooms>,
    /// Acknowledgements this server is waiting for (`socket.acks`).
    pub acks: Mutex<HashMap<u64, oneshot::Sender<Vec<Value>>>>,
    /// Per-socket FIFO queues standing in for the handlers' `AsyncLock`s.
    pub queues: Mutex<HashMap<&'static str, mpsc::UnboundedSender<BoxFuture<'static, ()>>>>,
    /// The last `message` handed to a session writer, until it is written: a
    /// message for another session waits for it, as TS's per-socket lock would.
    pub last_message: Mutex<Option<(String, oneshot::Receiver<()>)>>,
}

#[derive(Default)]
pub struct SocketRooms {
    pub joined: HashSet<String>,
    pub closed: bool,
}

impl SocketHandle {
    pub fn send_packet(&self, text: String, attachments: Vec<Vec<u8>>) {
        let _ = self.tx.send(crate::engine::Cmd::Emit(text, attachments));
    }

    /// `socket.emit(event, payload)`.
    pub fn emit(&self, event: &str, payload: Value) {
        let (t, a) = crate::socket::encode_event(event, &[payload]);
        self.send_packet(t, a);
    }

    pub fn is_closed(&self) -> bool {
        self.rooms.lock().closed
    }

    /// Runs `f` after every job queued before it on the same queue.
    pub fn enqueue(&self, queue: &'static str, f: BoxFuture<'static, ()>) {
        let mut q = self.queues.lock();
        let tx = q.entry(queue).or_insert_with(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<BoxFuture<'static, ()>>();
            tokio::spawn(async move {
                while let Some(job) = rx.recv().await {
                    job.await;
                }
            });
            tx
        });
        let _ = tx.send(f);
    }
}

/// Sockets and rooms (Socket.IO's in-memory adapter). Both maps are sharded, so
/// fan-out for one user never contends with another user's traffic. Rooms keep
/// join order: RPC routing picks the earliest socket still in the room.
#[derive(Default)]
pub struct Hub {
    sockets: DashMap<String, Arc<SocketHandle>>,
    rooms: DashMap<String, IndexMap<String, Arc<SocketHandle>>>,
}

pub enum Filter<'a> {
    AllUser,
    UserScopedOnly,
    Session(&'a str),
    Machine(&'a str),
}

impl Hub {
    pub fn add_socket(&self, s: Arc<SocketHandle>) {
        self.sockets.insert(s.id.clone(), s);
    }

    pub fn remove_socket(&self, id: &str) {
        let Some((_, s)) = self.sockets.remove(id) else { return };
        let mut st = s.rooms.lock();
        st.closed = true;
        for room in st.joined.drain() {
            self.room_remove(&room, id);
        }
    }

    fn room_remove(&self, room: &str, id: &str) {
        if let dashmap::mapref::entry::Entry::Occupied(mut e) = self.rooms.entry(room.to_string()) {
            e.get_mut().shift_remove(id);
            if e.get().is_empty() {
                e.remove();
            }
        }
    }

    pub fn join(self: &Hub, s: &Arc<SocketHandle>, room: &str) {
        let mut st = s.rooms.lock();
        if st.closed {
            return; // disconnected meanwhile
        }
        if st.joined.insert(room.to_string()) {
            self.rooms.entry(room.to_string()).or_default().insert(s.id.clone(), s.clone());
        }
    }

    pub fn leave(&self, s: &SocketHandle, room: &str) {
        let mut st = s.rooms.lock();
        if st.joined.remove(room) {
            self.room_remove(room, &s.id);
        }
    }

    pub fn sockets_in(&self, room: &str) -> Vec<Arc<SocketHandle>> {
        self.rooms.get(room).map(|m| m.values().cloned().collect()).unwrap_or_default()
    }

    pub fn room_has(&self, room: &str, id: &str) -> bool {
        self.rooms.get(room).map(|m| m.contains_key(id)).unwrap_or(false)
    }

    pub fn socket(&self, id: &str) -> Option<Arc<SocketHandle>> {
        self.sockets.get(id).map(|s| s.clone())
    }

    pub fn socket_count(&self) -> usize {
        self.sockets.len()
    }

    /// Broadcast to the union of rooms (deduplicated), optionally excluding a socket.
    /// The packet is encoded once; no lock is held while sending.
    pub fn emit_rooms(&self, rooms: &[String], except: Option<&str>, event: &str, payload: &Value) {
        // One shard guard at a time (holding two could deadlock against a writer).
        let mut targets: Vec<Arc<SocketHandle>> = Vec::new();
        let mut seen: HashSet<*const SocketHandle> = HashSet::new();
        for room in rooms {
            if let Some(m) = self.rooms.get(room) {
                for (id, s) in m.iter() {
                    if Some(id.as_str()) != except && (rooms.len() == 1 || seen.insert(Arc::as_ptr(s))) {
                        targets.push(s.clone());
                    }
                }
            }
        }
        if targets.is_empty() {
            return;
        }
        let (text, atts) = crate::socket::encode_event(event, std::slice::from_ref(payload));
        for s in targets {
            s.send_packet(text.clone(), atts.clone());
        }
    }

    fn rooms_for(user_id: &str, f: &Filter) -> Vec<String> {
        match f {
            Filter::AllUser => vec![format!("user:{}", user_id)],
            Filter::UserScopedOnly => vec![format!("user:{}:user-scoped", user_id)],
            Filter::Session(sid) => vec![format!("user:{}:session:{}", user_id, sid), format!("user:{}:user-scoped", user_id)],
            Filter::Machine(mid) => vec![format!("user:{}:machine:{}", user_id, mid), format!("user:{}:user-scoped", user_id)],
        }
    }

    pub fn emit_update(&self, user_id: &str, payload: Value, f: Filter, skip: Option<&str>) {
        self.emit_rooms(&Self::rooms_for(user_id, &f), skip, "update", &payload);
    }

    pub fn emit_ephemeral(&self, user_id: &str, payload: Value, f: Filter) {
        self.emit_rooms(&Self::rooms_for(user_id, &f), None, "ephemeral", &payload);
    }

    /// `hasActiveUiClient`: a user-scoped socket that reported `app-state: active`.
    pub fn has_active_ui_client(&self, user_id: &str) -> bool {
        self.sockets_in(&format!("user:{}", user_id))
            .iter()
            .any(|s| s.client_type_raw.as_deref() == Some("user-scoped") && *s.app_state.lock() == Some("active"))
    }
}

// ---------------------------------------------------------------------------
// Builders (eventRouter.ts)
// ---------------------------------------------------------------------------

fn update(seq: i32, body: Value) -> Value {
    json!({ "id": random_key_naked(12), "seq": seq, "body": body, "createdAt": now_ms() })
}

pub fn session_avatar(r#ref: &Option<String>, preview: &Option<String>, version: i32) -> Value {
    match (r#ref, preview) {
        (Some(r), Some(p)) if !r.is_empty() && !p.is_empty() => json!({"ref": r, "preview": p, "version": version}),
        _ => Value::Null,
    }
}

pub fn new_session_update(s: &crate::models::Session, seq: i32) -> Value {
    update(
        seq,
        json!({
            "t": "new-session",
            "id": s.id,
            "seq": s.seq,
            "metadata": s.metadata,
            "metadataVersion": s.metadata_version,
            "agentState": s.agent_state,
            "agentStateVersion": s.agent_state_version,
            "dataEncryptionKey": s.data_encryption_key.as_ref().map(|b| b64_encode(b)),
            "projectId": s.project_id,
            "avatar": session_avatar(&s.avatar_ref, &s.avatar_preview, s.avatar_version),
            "avatarVersion": s.avatar_version,
            "active": s.active,
            "activeAt": naive_to_ms(s.last_active_at),
            "createdAt": naive_to_ms(s.created_at),
            "updatedAt": naive_to_ms(s.updated_at),
        }),
    )
}

pub fn simple_update(seq: i32, t: &str, key: &str, id: &str) -> Value {
    let mut b = Map::new();
    b.insert("t".into(), json!(t));
    b.insert(key.into(), json!(id));
    update(seq, Value::Object(b))
}

pub fn new_message_update(msg: &Value, session_id: &str, seq: i32) -> Value {
    update(seq, json!({ "t": "new-message", "sid": session_id, "message": msg }))
}

/// `buildUpdateSessionUpdate`: `undefined` arguments are omitted from JSON.
pub struct SessionUpdate {
    pub metadata: Option<Value>,
    pub agent_state: Option<Value>,
    pub project_id: Option<Value>,
    pub avatar: Option<Value>,
    pub avatar_version: Option<i32>,
}

pub fn update_session_update(session_id: &str, seq: i32, u: SessionUpdate) -> Value {
    let mut b = Map::new();
    b.insert("t".into(), json!("update-session"));
    b.insert("id".into(), json!(session_id));
    if let Some(m) = u.metadata {
        b.insert("metadata".into(), m);
    }
    if let Some(a) = u.agent_state {
        b.insert("agentState".into(), a);
    }
    if let Some(a) = u.avatar {
        b.insert("avatar".into(), a);
    }
    if let Some(v) = u.avatar_version {
        b.insert("avatarVersion".into(), json!(v));
    }
    if let Some(p) = u.project_id {
        b.insert("projectId".into(), p);
    }
    update(seq, Value::Object(b))
}

/// `buildUpdateAccountUpdate(userId, profile)`: profile keys in given order, then
/// `avatar` (with `url`) or omitted.
pub fn update_account_update(user_id: &str, profile: Vec<(&str, Value)>, avatar: Option<Value>, seq: i32) -> Value {
    let mut b = Map::new();
    b.insert("t".into(), json!("update-account"));
    b.insert("id".into(), json!(user_id));
    for (k, v) in profile {
        b.insert(k.into(), v);
    }
    match avatar {
        Some(a) => {
            b.insert("avatar".into(), a);
        }
        None => {
            b.shift_remove("avatar");
        }
    }
    update(seq, Value::Object(b))
}

pub fn new_machine_update(m: &crate::models::Machine, seq: i32) -> Value {
    update(
        seq,
        json!({
            "t": "new-machine",
            "machineId": m.id,
            "seq": m.seq,
            "metadata": m.metadata,
            "metadataVersion": m.metadata_version,
            "daemonState": m.daemon_state,
            "daemonStateVersion": m.daemon_state_version,
            "dataEncryptionKey": m.data_encryption_key.as_ref().map(|b| b64_encode(b)),
            "active": m.active,
            "activeAt": naive_to_ms(m.last_active_at),
            "createdAt": naive_to_ms(m.created_at),
            "updatedAt": naive_to_ms(m.updated_at),
        }),
    )
}

pub fn update_machine_update(machine_id: &str, seq: i32, metadata: Option<Value>, daemon_state: Option<Value>) -> Value {
    let mut b = Map::new();
    b.insert("t".into(), json!("update-machine"));
    b.insert("machineId".into(), json!(machine_id));
    if let Some(m) = metadata {
        b.insert("metadata".into(), m);
    }
    if let Some(d) = daemon_state {
        b.insert("daemonState".into(), d);
    }
    update(seq, Value::Object(b))
}

pub fn new_artifact_update(a: &crate::models::Artifact, seq: i32) -> Value {
    update(
        seq,
        json!({
            "t": "new-artifact",
            "artifactId": a.id,
            "seq": a.seq,
            "header": b64_encode(&a.header),
            "headerVersion": a.header_version,
            "body": b64_encode(&a.body),
            "bodyVersion": a.body_version,
            "dataEncryptionKey": b64_encode(&a.data_encryption_key),
            "createdAt": naive_to_ms(a.created_at),
            "updatedAt": naive_to_ms(a.updated_at),
        }),
    )
}

pub fn update_artifact_update(id: &str, seq: i32, header: Option<Value>, body: Option<Value>) -> Value {
    let mut b = Map::new();
    b.insert("t".into(), json!("update-artifact"));
    b.insert("artifactId".into(), json!(id));
    if let Some(h) = header {
        b.insert("header".into(), h);
    }
    if let Some(x) = body {
        b.insert("body".into(), x);
    }
    update(seq, Value::Object(b))
}

pub fn new_feed_post_update(item: &Value, seq: i32) -> Value {
    update(
        seq,
        json!({
            "t": "new-feed-post",
            "id": item["id"],
            "body": item["body"],
            "cursor": item["cursor"],
            "createdAt": item["createdAt"],
        }),
    )
}

pub fn kv_batch_update(changes: Vec<Value>, seq: i32) -> Value {
    update(seq, json!({ "t": "kv-batch-update", "changes": changes }))
}

/// `activeAt` is a JS number (heartbeat times may be fractional).
pub fn session_activity(id: &str, active: bool, active_at: f64, thinking: bool) -> Value {
    json!({ "type": "activity", "id": id, "active": active, "activeAt": js::num(active_at), "thinking": thinking })
}

pub fn machine_activity(id: &Value, active: bool, active_at: f64) -> Value {
    json!({ "type": "machine-activity", "id": id, "active": active, "activeAt": js::num(active_at) })
}

pub fn usage_ephemeral(session_id: &str, key: &str, tokens: &Value, cost: &Value) -> Value {
    json!({ "type": "usage", "id": session_id, "key": key, "tokens": tokens, "cost": cost, "timestamp": now_ms() })
}

pub fn session_event_ephemeral(session_id: &str, kind: &str, title: &str, body: &str) -> Value {
    json!({ "type": "session-event", "sessionId": session_id, "kind": kind, "title": title, "body": body, "timestamp": now_ms() })
}

pub fn ms(t: chrono::NaiveDateTime) -> Value {
    js::num(naive_to_ms(t) as f64)
}
