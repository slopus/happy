//! `rpcHandler.ts`: daemons join `rpc:<user>:<method>` rooms; a call goes to the
//! earliest socket in the room with `emitWithAck`, waits out a 15 s reconnect
//! grace window when the room is empty, and gives up after 30 s or two
//! consecutive presence misses.

use crate::app::App;
use crate::events::SocketHandle;
use crate::handlers::{crashed, Args};
use crate::js;
use crate::socket;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const CALL_TIMEOUT: Duration = Duration::from_millis(30_000);
const PRESENCE_POLL: Duration = Duration::from_millis(2_000);
const RECONNECT_GRACE: Duration = Duration::from_millis(15_000);
const RECONNECT_POLL: Duration = Duration::from_millis(200);

/// The namespace-wide `nsp._ids` counter for server-sent acks.
static NEXT_ACK_ID: AtomicU64 = AtomicU64::new(0);

fn base_method_name(m: &str) -> String {
    match m.rfind(':') {
        Some(i) => m[i + 1..].to_string(),
        None => m.to_string(),
    }
}

/// `rpc-register` (join = true) and `rpc-unregister`.
pub fn register(app: &Arc<App>, s: &Arc<SocketHandle>, args: &Args, join: bool) {
    let d = args.j(0);
    let method = if d.nullish() { None } else { d.get("method") };
    match method {
        Some(Value::String(m)) if !m.is_empty() => {
            let room = format!("rpc:{}:{}", s.user_id, m);
            if join {
                app.hub.join(s, &room);
            } else {
                app.hub.leave(s, &room);
            }
            s.emit(if join { "rpc-registered" } else { "rpc-unregistered" }, json!({"method": m}));
        }
        _ => s.emit("rpc-error", json!({"type": if join { "register" } else { "unregister" }, "error": "Invalid method name"})),
    }
}

pub async fn call(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let start = Instant::now();
    let d = args.j(0);
    let (method, params) = if d.nullish() { (None, None) } else { (d.get("method"), d.get("params")) };
    let cb = args.j(1);
    let label = match method {
        Some(Value::String(m)) if !m.is_empty() => base_method_name(m),
        m if !js::truthy(m) => "unknown".to_string(),
        _ => {
            // `baseMethodName` calls string methods on it: TypeError in finish(), twice.
            crashed("rpc-call", &anyhow::anyhow!("TypeError: prefixedMethod.lastIndexOf is not a function"));
            return;
        }
    };
    let finish = |result: &str| {
        app.metrics.rpc_calls.with_label_values(&[&label, result]).inc();
        app.metrics.rpc_duration.with_label_values(&[&label, result]).observe(start.elapsed().as_secs_f64());
    };
    let reply = |v: Value| {
        if let Err(e) = cb.call_opt(v) {
            finish("internal_error");
            crashed("rpc-call", &e);
        }
    };
    let Some(Value::String(method)) = method.filter(|m| js::truthy(Some(m))) else {
        finish("invalid_params");
        reply(json!({"ok": false, "error": "Invalid parameters: method is required"}));
        return;
    };

    let room = format!("rpc:{}:{}", s.user_id, method);
    let mut targets = app.hub.sockets_in(&room);
    if targets.is_empty() {
        let deadline = Instant::now() + RECONNECT_GRACE;
        let mut polls = 0u32;
        loop {
            targets = app.hub.sockets_in(&room);
            if !targets.is_empty() || Instant::now() >= deadline {
                app.metrics.rpc_lookup_retries.with_label_values(&[&label]).observe(polls as f64);
                break;
            }
            polls += 1;
            tokio::time::sleep(RECONNECT_POLL).await;
        }
    }
    let Some(target) = targets.first().cloned() else {
        finish("not_available");
        reply(json!({"ok": false, "error": "RPC method not available"}));
        return;
    };
    if targets.len() > 1 {
        tracing::warn!(module = "websocket", "Multiple sockets in {} ({}); using first", room, targets.len());
    }
    if target.id == s.id {
        finish("self_call");
        reply(json!({"ok": false, "error": "Cannot call RPC on the same socket"}));
        return;
    }

    // target.timeout(30s).emitWithAck('rpc-request', { method, params })
    let id = NEXT_ACK_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel::<Vec<Value>>();
    let delivered = {
        let st = target.rooms.lock();
        if !st.closed {
            target.acks.lock().insert(id, tx);
        }
        !st.closed
    };
    if delivered {
        let mut req = Map::new();
        req.insert("method".into(), json!(method));
        if let Some(p) = params {
            req.insert("params".into(), p.clone());
        }
        let (t, a) = socket::encode(socket::EVENT, "/", Some(id as f64), Some(&json!(["rpc-request", Value::Object(req)])));
        target.send_packet(t, a);
    }
    let ack = async {
        if !delivered {
            // No socket matched: the broadcast completes at once with no response.
            return Ok(None);
        }
        match rx.await {
            Ok(args) => Ok(args.into_iter().next()),
            Err(_) => std::future::pending().await,
        }
    };
    let presence = async {
        let mut misses = 0;
        loop {
            tokio::time::sleep(PRESENCE_POLL).await;
            if !app.hub.room_has(&room, &target.id) {
                misses += 1;
                if misses >= 2 {
                    return Err("RPC target disconnected");
                }
            } else {
                misses = 0;
            }
        }
    };
    let r: Result<Option<Value>, &str> = tokio::select! {
        r = ack => r,
        _ = tokio::time::sleep(CALL_TIMEOUT) => Err("operation has timed out"),
        e = presence => e,
    };
    target.acks.lock().remove(&id);
    match r {
        Ok(response) => {
            finish("success");
            let mut o = Map::new();
            o.insert("ok".into(), json!(true));
            if let Some(v) = response {
                o.insert("result".into(), v);
            }
            reply(Value::Object(o));
        }
        Err(msg) => {
            finish(if msg == "RPC target disconnected" { "target_disconnected" } else { "timeout" });
            reply(json!({"ok": false, "error": msg}));
        }
    }
}
