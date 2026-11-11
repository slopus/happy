//! Engine.IO v4 server as engine.io 6.6 runs it under `socketConfig.ts`: polling
//! and websocket transports, the polling → websocket upgrade, server-driven
//! heartbeats, the `cors` middleware, the error answers of `verify()`, and the
//! `ws` handshake checks.
//!
//! One actor task per session owns the transport state and the Socket.IO client
//! state (`sio.rs`); HTTP requests, websocket readers, handlers and the hub talk
//! to it through [`Cmd`]. Nothing is locked across sessions.

use crate::app::App;
use crate::http::{HttpResponse, RespBody as Body};
use crate::util::b64_encode;
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use http::{HeaderMap, Method};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::WebSocketStream;

/// `path: '/v1/updates'` (engine.io appends the slash and matches by prefix).
pub const PATH: &str = "/v1/updates/";
pub const PING_INTERVAL: Duration = Duration::from_millis(15_000);
pub const PING_TIMEOUT: Duration = Duration::from_millis(45_000);
const UPGRADE_TIMEOUT: Duration = Duration::from_millis(10_000);
const UPGRADE_CHECK: Duration = Duration::from_millis(100);
const POLL_CLOSE_TIMEOUT: Duration = Duration::from_millis(30_000);
const WS_CLOSE_TIMEOUT: Duration = Duration::from_millis(30_000);
pub const MAX_PAYLOAD: usize = 8 * 1024 * 1024;
/// engine.io's default `httpCompression.threshold`.
const COMPRESS_THRESHOLD: usize = 1024;

const ERROR_MESSAGES: [&str; 6] = ["Transport unknown", "Session ID unknown", "Bad handshake method", "Bad request", "Forbidden", "Unsupported protocol version"];

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// Ends the HTTP connection without an answer, as Node does when it destroys the socket.
#[derive(Debug)]
pub struct Destroy;
impl std::fmt::Display for Destroy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("connection destroyed")
    }
}
impl std::error::Error for Destroy {}

#[derive(Default)]
pub struct Engine {
    sessions: DashMap<String, Entry>,
}

#[derive(Clone)]
struct Entry {
    tx: mpsc::UnboundedSender<Cmd>,
    /// The session's current transport is websocket (`verify()` compares names).
    websocket: Arc<AtomicBool>,
}

impl Engine {
    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    /// `io.close()`: every session is closed with its transport discarded.
    pub fn shutdown(&self) {
        for e in self.sessions.iter() {
            let _ = e.tx.send(Cmd::Shutdown);
        }
    }
}

pub enum Cmd {
    Poll { rid: u64, reply: oneshot::Sender<PollReply> },
    PollGone { rid: u64 },
    DataStart { rid: u64, binary: bool, reply: oneshot::Sender<DataStartReply> },
    /// The reply is dropped when the request was destroyed meanwhile.
    DataEnd { rid: u64, end: DataEnd, reply: oneshot::Sender<()> },
    WsUpgrade { tid: u64, out: mpsc::UnboundedSender<WsOut>, binary: bool },
    Ws { tid: u64, ev: WsIn },
    /// A Socket.IO packet (text plus binary attachments) for the client.
    Emit(String, Vec<Vec<u8>>),
    Shutdown,
}

pub enum PollReply {
    /// Payload, and whether engine.io would compress it.
    Payload(String, bool),
    Overlap,
}

pub enum DataStartReply {
    Go,
    Overlap,
    Hang,
}

pub enum DataEnd {
    Body(String),
    TooLarge,
    Aborted,
}

pub enum WsOut {
    Text(String),
    Binary(Vec<u8>),
    Close(Option<u16>),
}

pub enum WsIn {
    Text(String),
    Binary(Vec<u8>),
    Closed,
    /// A protocol error; `ws` closes with this code and emits `error`.
    Error(Option<u16>),
}

// ---------------------------------------------------------------------------
// Packets (engine.io-parser 5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Msg {
    Text(String),
    Binary(Vec<u8>),
    /// A `4` without data (`socket.io` then fails on `undefined`).
    Empty,
}

#[derive(Debug, Clone)]
pub enum Packet {
    Open(String),
    Close,
    Ping(Option<String>),
    Pong(Option<String>),
    Message(Msg),
    Upgrade,
    Noop,
    Error,
}

fn decode_packet(s: &str) -> Packet {
    let mut it = s.chars();
    let Some(t) = it.next() else { return Packet::Error };
    let rest = it.as_str();
    let data = if rest.is_empty() { None } else { Some(rest.to_string()) };
    match t {
        'b' => Packet::Message(Msg::Binary(crate::util::node_b64_decode(rest))),
        '0' => Packet::Open(rest.to_string()),
        '1' => Packet::Close,
        '2' => Packet::Ping(data),
        '3' => Packet::Pong(data),
        '4' => Packet::Message(data.map(Msg::Text).unwrap_or(Msg::Empty)),
        '5' => Packet::Upgrade,
        '6' => Packet::Noop,
        _ => Packet::Error,
    }
}

/// `encodePacket` for the text representation (binary as `b<base64>`).
fn encode_text(p: &Packet) -> String {
    match p {
        Packet::Open(d) => format!("0{}", d),
        Packet::Close => "1".into(),
        Packet::Ping(d) => format!("2{}", d.as_deref().unwrap_or("")),
        Packet::Pong(d) => format!("3{}", d.as_deref().unwrap_or("")),
        Packet::Message(Msg::Text(t)) => format!("4{}", t),
        Packet::Message(Msg::Binary(b)) => format!("b{}", b64_encode(b)),
        Packet::Message(Msg::Empty) => "4".into(),
        Packet::Upgrade => "5".into(),
        Packet::Noop => "6".into(),
        Packet::Error => String::new(),
    }
}

// ---------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------

pub fn is_engine_path(url: &str) -> bool {
    url.starts_with(PATH)
}

/// Node emits `upgrade` instead of `request` for `Connection: upgrade` + `Upgrade`.
pub fn is_upgrade(h: &HeaderMap) -> bool {
    h.contains_key("upgrade")
        && h.get_all("connection")
            .iter()
            .any(|v| v.to_str().map(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade"))).unwrap_or(false))
}

/// `Object.fromEntries(new URL(url).searchParams)`: form decoding, last value wins.
pub fn search_params(url: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(i) = url.find('?') else { return out };
    let q = &url[i + 1..];
    let q = q.split('#').next().unwrap_or("");
    for part in q.split('&') {
        if part.is_empty() {
            continue;
        }
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        out.insert(form_decode(k), form_decode(v));
    }
    out
}

fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'+' {
            out.push(b' ');
        } else if c == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap(), 16).unwrap());
            i += 3;
            continue;
        } else {
            out.push(c);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// engine.io's `checkInvalidHeaderChar` on the Origin header (latin-1 bytes).
/// `polling-jsonp`'s `onData`: the `d` form field with its newline escapes undone.
fn jsonp_data(body: &str) -> Option<String> {
    let mut found: Option<String> = None;
    let mut count = 0;
    for part in body.split('&').take(1000) {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        if form_decode(k) == "d" {
            count += 1;
            found = Some(form_decode(v));
        }
    }
    if count != 1 {
        return None; // absent, or an array
    }
    let d = found?;
    // `/(\\)?\\n/g`: "\\n" becomes a newline, "\\\\n" stays; then "\\\\n" → "\\n".
    let c: Vec<char> = d.chars().collect();
    let mut out = String::with_capacity(d.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\\' && c.get(i + 1) == Some(&'\\') && c.get(i + 2) == Some(&'n') {
            out.push_str("\\\\n");
            i += 3;
        } else if c[i] == '\\' && c.get(i + 1) == Some(&'n') {
            out.push('\n');
            i += 2;
        } else {
            out.push(c[i]);
            i += 1;
        }
    }
    Some(out.replace("\\\\n", "\\n"))
}

fn invalid_header_chars(v: &[u8]) -> bool {
    v.iter().any(|&c| (c < 32 && c != 9) || c == 127)
}

fn cors(b: http::response::Builder) -> http::response::Builder {
    b.header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Credentials", "true")
}

/// `res.writeHead(status); res.end(body)`: Node frames it chunked.
fn chunked(status: u16, ct: Option<&str>, body: &str) -> HttpResponse {
    let mut b = cors(hyper::Response::builder().status(status));
    if let Some(ct) = ct {
        b = b.header("Content-Type", ct);
    }
    b.body(Body::chunked(Bytes::from(body.to_string()))).unwrap()
}

fn abort_request(code: usize) -> HttpResponse {
    let body = format!(r#"{{"code":{},"message":"{}"}}"#, code, ERROR_MESSAGES[code]);
    chunked(if code == 4 { 403 } else { 400 }, Some("application/json"), &body)
}

/// `abortUpgrade` / `ws`'s `abortHandshake`: a bare response, then the socket is closed.
fn abort_raw(status: u16, message: &str, extra: Option<(&str, &str)>) -> HttpResponse {
    let mut b = hyper::Response::builder()
        .status(status)
        .header("Connection", "close")
        .header("Content-Type", "text/html")
        .header("Content-Length", message.len().to_string());
    if let Some((k, v)) = extra {
        b = b.header(k, v);
    }
    b.body(Body::full(Bytes::from(message.to_string()))).unwrap()
}

fn preflight() -> HttpResponse {
    cors(hyper::Response::builder().status(204))
        .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        .header("Access-Control-Allow-Headers", "*")
        .header("Content-Length", "0")
        .body(Body::full(Bytes::new()))
        .unwrap()
}

fn verify(app: &App, q: &HashMap<String, String>, method: &Method, upgrade: bool, origin_bad: bool) -> Result<(), usize> {
    let t = q.get("transport").map(String::as_str);
    if !matches!(t, Some("websocket") | Some("polling")) {
        return Err(0);
    }
    if origin_bad {
        return Err(3);
    }
    match q.get("sid").filter(|s| !s.is_empty()) {
        Some(sid) => {
            let Some(e) = app.engine.sessions.get(sid) else { return Err(1) };
            let prev = if e.websocket.load(Ordering::Relaxed) { "websocket" } else { "polling" };
            if !upgrade && Some(prev) != t {
                return Err(3);
            }
        }
        None => {
            if method != Method::GET {
                return Err(2);
            }
            if t == Some("websocket") && !upgrade {
                return Err(3);
            }
        }
    }
    Ok(())
}

/// Requests under [`PATH`] never reach the Fastify-style router.
pub async fn handle(app: Arc<App>, req: hyper::Request<Incoming>) -> Result<HttpResponse, Destroy> {
    let upgrade = is_upgrade(req.headers());
    let method = req.method().clone();
    let url = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
    let q = search_params(&url);
    // `cors` middleware: preflights end here (for an upgrade, `res.end()` destroys the socket).
    if method == Method::OPTIONS {
        return if upgrade { Err(Destroy) } else { Ok(preflight()) };
    }
    let origin_bad = req.headers().get("origin").map(|v| invalid_header_chars(v.as_bytes())).unwrap_or(false);
    if let Err(code) = verify(&app, &q, &method, upgrade, origin_bad) {
        return Ok(if upgrade { abort_raw(400, ERROR_MESSAGES[code], None) } else { abort_request(code) });
    }
    if upgrade {
        return ws_handshake(app, req, q);
    }
    let sid = q.get("sid").filter(|s| !s.is_empty()).cloned();
    let Some(sid) = sid else {
        // Polling handshake (verify() guarantees GET + polling).
        if q.get("EIO").map(String::as_str) != Some("4") {
            return Ok(abort_request(5));
        }
        let entry = spawn_session(&app, req.headers(), q.get("j").map(String::as_str));
        return poll(entry, req.headers().clone()).await;
    };
    let Some(entry) = app.engine.sessions.get(&sid).map(|e| e.clone()) else { return Ok(abort_request(1)) };
    match method {
        Method::GET => poll(entry, req.headers().clone()).await,
        Method::POST => data(entry, req).await,
        _ => Ok(chunked(500, None, "")),
    }
}

struct PollGuard {
    tx: mpsc::UnboundedSender<Cmd>,
    rid: u64,
    armed: bool,
}

impl Drop for PollGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.tx.send(Cmd::PollGone { rid: self.rid });
        }
    }
}

async fn poll(entry: Entry, headers: HeaderMap) -> Result<HttpResponse, Destroy> {
    let rid = next_id();
    let (reply, rx) = oneshot::channel();
    if entry.tx.send(Cmd::Poll { rid, reply }).is_err() {
        return Ok(abort_request(1));
    }
    let mut guard = PollGuard { tx: entry.tx.clone(), rid, armed: true };
    let r = rx.await;
    guard.armed = false;
    match r {
        Ok(PollReply::Payload(s, compress)) => Ok(payload_response(s, compress, &headers).await),
        Ok(PollReply::Overlap) => Ok(chunked(400, None, "")),
        Err(_) => Ok(abort_request(1)),
    }
}

/// `negotiator`'s pick between gzip and deflate.
fn pick_encoding(h: &HeaderMap) -> Option<&'static str> {
    let ae = h.get("accept-encoding")?.to_str().ok()?;
    let specs: Vec<(String, f64, usize)> = ae
        .split(',')
        .enumerate()
        .filter_map(|(i, part)| {
            let mut it = part.split(';');
            let name = it.next()?.trim().to_ascii_lowercase();
            if name.is_empty() {
                return None;
            }
            let mut q = 1.0;
            for p in it {
                if let Some((k, v)) = p.split_once('=') {
                    if k.trim() == "q" {
                        q = v.trim().parse().unwrap_or(1.0);
                    }
                }
            }
            Some((name, q, i))
        })
        .collect();
    let mut best: Vec<(f64, i32, usize, usize, &'static str)> = Vec::new();
    for (pi, enc) in ["gzip", "deflate"].into_iter().enumerate() {
        let mut pr: Option<(i32, f64, usize)> = None;
        for (name, q, o) in &specs {
            let s = if name == enc {
                1
            } else if name == "*" {
                0
            } else {
                continue;
            };
            let better = match pr {
                None => true,
                Some((ps, pq, po)) => (ps - s) < 0 || (ps == s && (pq - q) < 0.0) || (ps == s && pq == *q && po < *o),
            };
            if better {
                pr = Some((s, *q, *o));
            }
        }
        if let Some((s, q, o)) = pr {
            if q > 0.0 {
                best.push((q, s, o, pi, enc));
            }
        }
    }
    best.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)).then(a.3.cmp(&b.3)));
    best.first().map(|b| b.4)
}

/// Polling's `headers()`: IE gets `X-XSS-Protection: 0`.
fn ie_header(b: http::response::Builder, h: &HeaderMap) -> http::response::Builder {
    let ua = h.get("user-agent").map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).unwrap_or_default();
    if ua.contains(";MSIE") || ua.contains("Trident/") {
        b.header("X-XSS-Protection", "0")
    } else {
        b
    }
}

async fn payload_response(s: String, compress: bool, headers: &HeaderMap) -> HttpResponse {
    let b = cors(hyper::Response::builder().status(200)).header("Content-Type", "text/plain; charset=UTF-8");
    let enc = if compress && s.len() >= COMPRESS_THRESHOLD { pick_encoding(headers) } else { None };
    let (b, body) = match enc {
        Some(enc) => {
            let data = s.into_bytes();
            let packed = if data.len() > 256 * 1024 {
                tokio::task::spawn_blocking(move || compress_bytes(enc, &data)).await.unwrap_or_default()
            } else {
                compress_bytes(enc, &data)
            };
            (b.header("Content-Encoding", enc), Bytes::from(packed))
        }
        None => (b, Bytes::from(s)),
    };
    ie_header(b.header("Content-Length", body.len().to_string()), headers).header("cache-control", "no-store").body(Body::full(body)).unwrap()
}

fn compress_bytes(enc: &str, data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    if enc == "gzip" {
        let mut e = flate2::GzBuilder::new().operating_system(3).write(Vec::new(), flate2::Compression::default());
        let _ = e.write_all(data);
        e.finish().unwrap_or_default()
    } else {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        let _ = e.write_all(data);
        e.finish().unwrap_or_default()
    }
}

struct DataGuard {
    tx: mpsc::UnboundedSender<Cmd>,
    rid: u64,
    armed: bool,
}

impl Drop for DataGuard {
    fn drop(&mut self) {
        if self.armed {
            let (reply, _) = oneshot::channel();
            let _ = self.tx.send(Cmd::DataEnd { rid: self.rid, end: DataEnd::Aborted, reply });
        }
    }
}

async fn data(entry: Entry, req: hyper::Request<Incoming>) -> Result<HttpResponse, Destroy> {
    let headers = req.headers().clone();
    let binary = req.headers().get("content-type").map(|v| v.as_bytes() == b"application/octet-stream").unwrap_or(false);
    let rid = next_id();
    let (reply, rx) = oneshot::channel();
    if entry.tx.send(Cmd::DataStart { rid, binary, reply }).is_err() {
        return Ok(abort_request(1));
    }
    match rx.await {
        Ok(DataStartReply::Go) => {}
        Ok(DataStartReply::Overlap) => return Ok(chunked(400, None, "")),
        Ok(DataStartReply::Hang) => {
            // engine.io closes the session and never answers this request.
            std::future::pending::<()>().await;
            return Err(Destroy);
        }
        Err(_) => return Ok(abort_request(1)),
    }
    let mut guard = DataGuard { tx: entry.tx.clone(), rid, armed: true };
    let mut body = req.into_body();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match body.frame().await {
            Some(Ok(f)) => {
                if let Ok(d) = f.into_data() {
                    buf.extend_from_slice(&d);
                    if buf.len() > MAX_PAYLOAD {
                        guard.armed = false;
                        let (reply, rx) = oneshot::channel();
                        let _ = entry.tx.send(Cmd::DataEnd { rid, end: DataEnd::TooLarge, reply });
                        return match rx.await {
                            Ok(()) => Ok(chunked(413, None, "")),
                            Err(_) => Err(Destroy),
                        };
                    }
                }
            }
            Some(Err(_)) => return Err(Destroy), // guard reports the abort
            None => break,
        }
    }
    guard.armed = false;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (reply, rx) = oneshot::channel();
    let _ = entry.tx.send(Cmd::DataEnd { rid, end: DataEnd::Body(text), reply });
    match rx.await {
        Ok(()) => Ok(ie_header(cors(hyper::Response::builder().status(200)).header("Content-Type", "text/html").header("Content-Length", "2"), &headers)
            .header("cache-control", "no-store")
            .body(Body::full(Bytes::from_static(b"ok")))
            .unwrap()),
        Err(_) => Err(Destroy),
    }
}

// ---------------------------------------------------------------------------
// WebSocket handshake and frame pumps
// ---------------------------------------------------------------------------

fn ws_key_valid(k: &str) -> bool {
    let b = k.as_bytes();
    b.len() == 24 && b[22] == b'=' && b[23] == b'=' && b[..22].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
}

fn is_token_char(c: char) -> bool {
    c.is_ascii() && !c.is_ascii_control() && !"()<>@,;:\\\"/[]?={} \t".contains(c)
}

/// `ws`'s `subprotocol.parse`: comma-separated tokens, no duplicates.
fn parse_protocols(h: &str) -> Result<Vec<String>, ()> {
    let mut out: Vec<String> = Vec::new();
    for p in h.split(',') {
        let t = p.trim_matches(|c| c == ' ' || c == '\t');
        if t.is_empty() || !t.chars().all(is_token_char) || out.iter().any(|x| x == t) {
            return Err(());
        }
        out.push(t.to_string());
    }
    Ok(out)
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_PAYLOAD)).max_frame_size(Some(MAX_PAYLOAD))
}

fn ws_handshake(app: Arc<App>, mut req: hyper::Request<Incoming>, q: HashMap<String, String>) -> Result<HttpResponse, Destroy> {
    let h = req.headers();
    if req.method() != Method::GET {
        return Ok(abort_raw(405, "Invalid HTTP method", None));
    }
    if !h.get("upgrade").and_then(|v| v.to_str().ok()).map(|v| v.eq_ignore_ascii_case("websocket")).unwrap_or(false) {
        return Ok(abort_raw(400, "Invalid Upgrade header", None));
    }
    let key = h.get("sec-websocket-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !ws_key_valid(key) {
        return Ok(abort_raw(400, "Missing or invalid Sec-WebSocket-Key header", None));
    }
    let version = h.get("sec-websocket-version").and_then(|v| v.to_str().ok()).map(|v| crate::js::number_from_str(v)).unwrap_or(f64::NAN);
    if version != 13.0 && version != 8.0 {
        return Ok(abort_raw(400, "Missing or invalid Sec-WebSocket-Version header", Some(("Sec-WebSocket-Version", "13, 8"))));
    }
    let protocol = match h.get("sec-websocket-protocol") {
        Some(v) => match v.to_str().map_err(|_| ()).and_then(parse_protocols) {
            Ok(p) => p.into_iter().next(),
            Err(()) => return Ok(abort_raw(400, "Invalid Sec-WebSocket-Protocol header", None)),
        },
        None => None,
    };
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let headers = h.clone();
    let on_upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else { return };
        let io = hyper_util::rt::TokioIo::new(upgraded);
        let transport = q.get("transport").map(String::as_str).unwrap_or("");
        let sid = q.get("sid").filter(|s| !s.is_empty()).cloned();
        let b64 = q.get("b64").is_some_and(|s| !s.is_empty());
        if transport == "polling" {
            // onWebSocket: the transport does not handle upgrades.
            ws_reject(WebSocketStream::from_raw_socket(io, Role::Server, Some(ws_config())).await).await;
            return;
        }
        match sid {
            Some(sid) => {
                let ws = WebSocketStream::from_raw_socket(io, Role::Server, Some(ws_config())).await;
                let Some(entry) = app.engine.sessions.get(&sid).map(|e| e.clone()) else {
                    ws_reject(ws).await;
                    return;
                };
                let tid = next_id();
                let out = spawn_ws(ws, tid, entry.tx.clone());
                let _ = entry.tx.send(Cmd::WsUpgrade { tid, out, binary: !b64 });
            }
            None => {
                if q.get("EIO").map(String::as_str) != Some("4") {
                    // handshake() fails after `ws` already switched protocols.
                    use tokio::io::AsyncWriteExt;
                    let msg = ERROR_MESSAGES[5];
                    let mut io = io;
                    let raw = format!(
                        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                        msg.len(),
                        msg
                    );
                    let _ = io.write_all(raw.as_bytes()).await;
                    let _ = io.shutdown().await;
                    return;
                }
                let ws = WebSocketStream::from_raw_socket(io, Role::Server, Some(ws_config())).await;
                let tid = next_id();
                let (tx, rx) = mpsc::unbounded_channel();
                let out = spawn_ws(ws, tid, tx.clone());
                start_session(&app, tx, rx, Some((tid, out)), b64, None, &headers);
            }
        }
    });
    let mut b = hyper::Response::builder()
        .status(101)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Accept", accept);
    if let Some(p) = protocol {
        b = b.header("Sec-WebSocket-Protocol", p);
    }
    Ok(cors(b).body(Body::full(Bytes::new())).unwrap())
}

type Io = hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>;

/// `websocket.close()` on a socket engine.io refuses.
async fn ws_reject(mut ws: WebSocketStream<Io>) {
    let _ = ws.send(Message::Close(None)).await;
    let _ = tokio::time::timeout(WS_CLOSE_TIMEOUT, async { while let Some(Ok(_)) = ws.next().await {} }).await;
}

fn error_code(e: &tungstenite::Error) -> Option<Option<u16>> {
    match e {
        tungstenite::Error::Capacity(_) => Some(Some(1009)),
        tungstenite::Error::Utf8(_) => Some(Some(1007)),
        tungstenite::Error::Protocol(_) => Some(Some(1002)),
        _ => None,
    }
}

/// Starts the reader and writer of one websocket; returns the writer's queue.
fn spawn_ws(ws: WebSocketStream<Io>, tid: u64, actor: mpsc::UnboundedSender<Cmd>) -> mpsc::UnboundedSender<WsOut> {
    let (mut sink, mut stream) = ws.split();
    // After a protocol error the reader hands its half over so the writer can
    // drain the socket like `ws` does: the peer then reads the close frame
    // instead of a connection reset.
    let (hand_tx, hand_rx) = oneshot::channel::<futures_util::stream::SplitStream<WebSocketStream<Io>>>();
    let reader = tokio::spawn(async move {
        loop {
            let ev = match stream.next().await {
                Some(Ok(Message::Text(t))) => WsIn::Text(t.as_str().to_owned()),
                Some(Ok(Message::Binary(b))) => WsIn::Binary(b.to_vec()),
                Some(Ok(_)) => continue,
                Some(Err(e)) => match error_code(&e) {
                    Some(code) => {
                        let _ = actor.send(Cmd::Ws { tid, ev: WsIn::Error(code) });
                        let _ = hand_tx.send(stream);
                        return;
                    }
                    None => WsIn::Closed,
                },
                None => WsIn::Closed,
            };
            let closed = matches!(ev, WsIn::Closed);
            let _ = actor.send(Cmd::Ws { tid, ev });
            if closed {
                return;
            }
        }
    });
    let (tx, mut rx) = mpsc::unbounded_channel::<WsOut>();
    tokio::spawn(async move {
        let mut closing = false;
        'outer: while let Some(first) = rx.recv().await {
            let mut next = Some(first);
            while let Some(m) = next.take() {
                let msg = match m {
                    WsOut::Text(s) => Message::text(s),
                    WsOut::Binary(b) => Message::binary(b),
                    WsOut::Close(code) => {
                        let frame = code.map(|c| CloseFrame { code: CloseCode::from(c), reason: "".into() });
                        let _ = sink.send(Message::Close(frame)).await;
                        closing = true;
                        break 'outer;
                    }
                };
                if sink.feed(msg).await.is_err() {
                    break 'outer;
                }
                next = rx.try_recv().ok();
            }
            if sink.flush().await.is_err() {
                break;
            }
        }
        if !closing {
            reader.abort();
            return;
        }
        // `ws` waits for the peer's close frame, then gives up after 30 s.
        let abort = reader.abort_handle();
        let waited = tokio::time::timeout(WS_CLOSE_TIMEOUT, async move {
            match hand_rx.await {
                Ok(stream) => {
                    if let Ok(mut ws) = sink.reunite(stream) {
                        // The receiver errored: end our side now, discard the rest.
                        use tokio::io::{AsyncReadExt, AsyncWriteExt};
                        let _ = ws.get_mut().shutdown().await;
                        let mut buf = vec![0u8; 64 * 1024];
                        while let Ok(n) = ws.get_mut().read(&mut buf).await {
                            if n == 0 {
                                break;
                            }
                        }
                    }
                }
                Err(_) => {
                    let _ = reader.await;
                }
            }
        })
        .await;
        if waited.is_err() {
            abort.abort();
        }
    });
    tx
}

// ---------------------------------------------------------------------------
// Session actor
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Open,
    Closing,
    Closed,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TState {
    Open,
    Closing,
    Closed,
}

/// What a transport runs once its close completes.
#[derive(Clone, Copy)]
enum CloseCb {
    Noop,
    ForcedClose,
}

struct Polling {
    /// `polling-jsonp`: the `___eio[n](` prefix when the handshake carried `j`.
    jsonp: Option<String>,
    state: TState,
    attached: bool,
    pending: Option<(u64, oneshot::Sender<PollReply>)>,
    data_req: Option<u64>,
    should_close: Option<(CloseCb, Instant)>,
    discarded: bool,
}

struct Ws {
    tid: u64,
    out: mpsc::UnboundedSender<WsOut>,
    /// Binary frames unless the request asked for `b64`.
    binary: bool,
    state: TState,
    attached: bool,
}

enum Transport {
    Polling(Polling),
    Ws(Ws),
}

struct Upgrade {
    tid: u64,
    out: mpsc::UnboundedSender<WsOut>,
    binary: bool,
    timeout_at: Instant,
    check_at: Option<Instant>,
}

pub(crate) struct Session {
    pub app: Arc<App>,
    pub id: String,
    pub tx: mpsc::UnboundedSender<Cmd>,
    websocket: Arc<AtomicBool>,
    pub state: State,
    transport: Transport,
    upgrade: Option<Upgrade>,
    upgraded: bool,
    write_buf: Vec<Packet>,
    close_on_drain: bool,
    ping_interval_at: Option<Instant>,
    ping_timeout_at: Option<Instant>,
    /// `x-happy-client` of the handshake request.
    pub happy_client_header: Option<String>,
    pub sio: crate::sio::SioState,
}

fn spawn_session(app: &Arc<App>, headers: &HeaderMap, jsonp: Option<&str>) -> Entry {
    let (tx, rx) = mpsc::unbounded_channel();
    start_session(app, tx, rx, None, false, jsonp, headers)
}

fn start_session(
    app: &Arc<App>,
    tx: mpsc::UnboundedSender<Cmd>,
    rx: mpsc::UnboundedReceiver<Cmd>,
    ws: Option<(u64, mpsc::UnboundedSender<WsOut>)>,
    b64: bool,
    jsonp: Option<&str>,
    headers: &HeaderMap,
) -> Entry {
    let id = crate::util::base64id();
    let websocket = Arc::new(AtomicBool::new(ws.is_some()));
    let transport = match ws {
        Some((tid, out)) => Transport::Ws(Ws { tid, out, binary: !b64, state: TState::Open, attached: true }),
        None => Transport::Polling(Polling {
            jsonp: jsonp.map(|j| format!("___eio[{}](", j.chars().filter(|c| c.is_ascii_digit()).collect::<String>())),
            state: TState::Open,
            attached: true,
            pending: None,
            data_req: None,
            should_close: None,
            discarded: false,
        }),
    };
    let entry = Entry { tx: tx.clone(), websocket: websocket.clone() };
    app.engine.sessions.insert(id.clone(), entry.clone());
    let s = Session {
        app: app.clone(),
        id,
        tx,
        websocket,
        state: State::Open,
        transport,
        upgrade: None,
        upgraded: false,
        write_buf: Vec::new(),
        close_on_drain: false,
        ping_interval_at: None,
        ping_timeout_at: None,
        happy_client_header: headers.get("x-happy-client").and_then(|v| v.to_str().ok()).map(|s| s.to_string()),
        sio: Default::default(),
    };
    tokio::spawn(run(s, rx));
    entry
}

async fn sleep_until_opt(t: Option<Instant>) {
    match t {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

async fn run(mut s: Session, mut rx: mpsc::UnboundedReceiver<Cmd>) {
    s.on_open();
    while s.state != State::Closed {
        let deadline = s.next_deadline();
        tokio::select! {
            biased;
            c = rx.recv() => match c {
                Some(c) => s.on_cmd(c),
                None => break,
            },
            _ = sleep_until_opt(deadline) => s.on_timers(),
        }
        s.sio_flush_connects();
    }
}

impl Session {
    fn on_open(&mut self) {
        let upgrades = if matches!(self.transport, Transport::Polling(_)) { r#"["websocket"]"# } else { "[]" };
        let open = format!(
            r#"{{"sid":"{}","upgrades":{},"pingInterval":{},"pingTimeout":{},"maxPayload":{}}}"#,
            self.id,
            upgrades,
            PING_INTERVAL.as_millis(),
            PING_TIMEOUT.as_millis(),
            MAX_PAYLOAD
        );
        self.send_packet(Packet::Open(open));
        self.ping_interval_at = Some(Instant::now() + PING_INTERVAL);
        self.sio_open();
    }

    fn next_deadline(&self) -> Option<Instant> {
        let mut d: Option<Instant> = None;
        let mut add = |t: Option<Instant>| {
            if let Some(t) = t {
                d = Some(d.map_or(t, |x| x.min(t)));
            }
        };
        add(self.ping_interval_at);
        add(self.ping_timeout_at);
        add(self.sio.connect_timeout_at);
        if let Transport::Polling(p) = &self.transport {
            add(p.should_close.map(|x| x.1));
        }
        if let Some(u) = &self.upgrade {
            add(Some(u.timeout_at));
            add(u.check_at);
        }
        d
    }

    fn on_timers(&mut self) {
        let now = Instant::now();
        if self.ping_timeout_at.is_some_and(|t| t <= now) {
            self.ping_timeout_at = None;
            self.on_close("ping timeout");
            return;
        }
        if self.ping_interval_at.is_some_and(|t| t <= now) {
            self.ping_interval_at = None;
            self.send_packet(Packet::Ping(None));
            self.ping_timeout_at = Some(Instant::now() + PING_TIMEOUT);
        }
        if let Transport::Polling(p) = &mut self.transport {
            if let Some((cb, at)) = p.should_close {
                if at <= now {
                    self.poll_close_done(cb);
                }
            }
        }
        if self.state == State::Closed {
            return;
        }
        if let Some(u) = &mut self.upgrade {
            if u.timeout_at <= now {
                let u = self.upgrade.take().unwrap();
                let _ = u.out.send(WsOut::Close(None));
            } else if u.check_at.is_some_and(|t| t <= now) {
                u.check_at = Some(now + UPGRADE_CHECK);
                if matches!(&self.transport, Transport::Polling(p) if p.pending.is_some()) {
                    self.transport_send(vec![Packet::Noop], false);
                }
            }
        }
        if self.sio.connect_timeout_at.is_some_and(|t| t <= now) {
            self.sio.connect_timeout_at = None;
            self.sio_connect_timeout();
        }
    }

    fn on_cmd(&mut self, c: Cmd) {
        match c {
            Cmd::Poll { rid, reply } => self.on_poll(rid, reply),
            Cmd::PollGone { rid } => {
                if matches!(&self.transport, Transport::Polling(p) if p.pending.as_ref().map(|x| x.0) == Some(rid)) {
                    self.on_close("transport error"); // poll connection closed prematurely
                }
            }
            Cmd::DataStart { rid, binary, reply } => {
                let Transport::Polling(p) = &mut self.transport else { return };
                if p.data_req.is_some() {
                    self.on_close("transport error"); // data request overlap from client
                    let _ = reply.send(DataStartReply::Overlap);
                } else if binary {
                    self.on_close("transport error"); // invalid content
                    let _ = reply.send(DataStartReply::Hang);
                } else {
                    p.data_req = Some(rid);
                    let _ = reply.send(DataStartReply::Go);
                }
            }
            Cmd::DataEnd { rid, end, reply } => {
                let Transport::Polling(p) = &mut self.transport else { return };
                if p.data_req != Some(rid) {
                    return; // destroyed
                }
                match end {
                    DataEnd::TooLarge => {
                        p.data_req = None;
                        let _ = reply.send(());
                    }
                    DataEnd::Aborted => {
                        p.data_req = None;
                        self.on_close("transport error"); // data request connection closed prematurely
                    }
                    DataEnd::Body(text) => {
                        // The body is complete: closing the transport now no longer
                        // destroys the request, and "ok" is still written.
                        p.data_req = None;
                        match &p.jsonp {
                            None => self.poll_on_data(&text),
                            Some(_) => {
                                if let Some(d) = jsonp_data(&text) {
                                    self.poll_on_data(&d);
                                }
                            }
                        }
                        let _ = reply.send(());
                    }
                }
            }
            Cmd::WsUpgrade { tid, out, binary } => {
                if self.upgrade.is_some() || self.upgraded {
                    let _ = out.send(WsOut::Close(None));
                } else {
                    self.upgrade = Some(Upgrade { tid, out, binary, timeout_at: Instant::now() + UPGRADE_TIMEOUT, check_at: None });
                }
            }
            Cmd::Ws { tid, ev } => {
                if self.upgrade.as_ref().map(|u| u.tid) == Some(tid) {
                    self.on_upgrade_ws(ev);
                } else if matches!(&self.transport, Transport::Ws(w) if w.tid == tid) {
                    self.on_ws(ev);
                }
            }
            Cmd::Emit(text, atts) => {
                if self.state == State::Open {
                    self.write_buf.push(Packet::Message(Msg::Text(text)));
                    for a in atts {
                        self.write_buf.push(Packet::Message(Msg::Binary(a)));
                    }
                    self.flush();
                }
            }
            Cmd::Shutdown => {
                if matches!(self.state, State::Open | State::Closing) {
                    if let Transport::Polling(p) = &mut self.transport {
                        p.discarded = true;
                    }
                    self.transport_close(CloseCb::ForcedClose);
                }
            }
        }
    }

    // --- socket.js ---------------------------------------------------------

    fn send_packet(&mut self, p: Packet) {
        if self.state == State::Open {
            self.write_buf.push(p);
            self.flush();
        }
    }

    fn writable(&self) -> bool {
        match &self.transport {
            Transport::Polling(p) => p.pending.is_some(),
            Transport::Ws(w) => w.state == TState::Open,
        }
    }

    fn flush(&mut self) {
        if self.state != State::Closed && self.writable() && !self.write_buf.is_empty() {
            let buf = std::mem::take(&mut self.write_buf);
            self.transport_send(buf, true);
            if self.close_on_drain {
                self.close_on_drain = false;
                self.transport_close(CloseCb::ForcedClose);
            }
        }
    }

    /// `socket.close()`: graceful, after the write buffer drains.
    pub(crate) fn close(&mut self) {
        if self.state != State::Open {
            return;
        }
        self.state = State::Closing;
        if !self.write_buf.is_empty() {
            self.close_on_drain = true;
            return;
        }
        self.transport_close(CloseCb::ForcedClose);
    }

    pub(crate) fn on_close(&mut self, reason: &str) {
        if self.state == State::Closed {
            return;
        }
        self.state = State::Closed;
        self.ping_interval_at = None;
        self.ping_timeout_at = None;
        self.write_buf.clear();
        self.clear_transport();
        if let Some(u) = self.upgrade.take() {
            let _ = u.out.send(WsOut::Close(None));
        }
        self.app.engine.sessions.remove(&self.id);
        self.sio_onclose(reason);
    }

    fn clear_transport(&mut self) {
        match &mut self.transport {
            Transport::Polling(p) => p.attached = false,
            Transport::Ws(w) => w.attached = false,
        }
        self.transport_close(CloseCb::Noop);
        self.ping_timeout_at = None;
    }

    fn on_packet(&mut self, p: Packet) {
        match p {
            Packet::Ping(_) => self.on_close("transport error"), // invalid heartbeat direction
            Packet::Pong(_) => {
                self.ping_timeout_at = None;
                self.ping_interval_at = Some(Instant::now() + PING_INTERVAL);
            }
            Packet::Error => self.on_close("parse error"),
            Packet::Message(m) => self.sio_ondata(m),
            _ => {}
        }
    }

    // --- transports --------------------------------------------------------

    fn transport_send(&mut self, mut packets: Vec<Packet>, compress: bool) {
        if let Transport::Ws(w) = &self.transport {
            for p in packets {
                let m = match p {
                    Packet::Message(Msg::Binary(b)) if w.binary => WsOut::Binary(b),
                    other => WsOut::Text(encode_text(&other)),
                };
                let _ = w.out.send(m);
            }
            return;
        }
        let Transport::Polling(p) = &mut self.transport else { return };
        let Some((_, reply)) = p.pending.take() else { return };
        if let Some((cb, _)) = p.should_close.take() {
            packets.push(Packet::Close);
            self.poll_close_done(cb);
        }
        let compress = compress && packets.iter().any(|p| !matches!(p, Packet::Noop | Packet::Close));
        let mut payload = packets.iter().map(encode_text).collect::<Vec<_>>().join("\u{1e}");
        if let Transport::Polling(Polling { jsonp: Some(head), .. }) = &self.transport {
            // Valid JavaScript, not just JSON.
            let js = crate::js::stringify(&serde_json::Value::String(payload)).replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
            payload = format!("{}{});", head, js);
        }
        let _ = reply.send(PollReply::Payload(payload, compress));
    }

    fn transport_close(&mut self, cb: CloseCb) {
        match &mut self.transport {
            Transport::Polling(p) => {
                if p.state != TState::Open {
                    return;
                }
                p.state = TState::Closing;
                p.data_req = None; // dataReq.destroy()
                if p.pending.is_some() {
                    self.transport_send(vec![Packet::Close], false);
                    self.poll_close_done(cb);
                } else if p.discarded {
                    self.poll_close_done(cb);
                } else {
                    p.should_close = Some((cb, Instant::now() + POLL_CLOSE_TIMEOUT));
                }
            }
            Transport::Ws(w) => {
                if w.state != TState::Open {
                    return;
                }
                w.state = TState::Closing;
                let _ = w.out.send(WsOut::Close(None));
                if let CloseCb::ForcedClose = cb {
                    self.on_close("forced close");
                }
            }
        }
    }

    /// The polling transport's close callback, then its own `onClose()`.
    fn poll_close_done(&mut self, cb: CloseCb) {
        if let Transport::Polling(p) = &mut self.transport {
            p.should_close = None;
        }
        if let CloseCb::ForcedClose = cb {
            self.on_close("forced close");
        }
        self.poll_transport_closed();
    }

    fn poll_transport_closed(&mut self) {
        let Transport::Polling(p) = &mut self.transport else { return };
        if p.state == TState::Closed {
            return;
        }
        if p.pending.is_some() {
            self.transport_send(vec![Packet::Noop], false);
        }
        let Transport::Polling(p) = &mut self.transport else { return };
        p.state = TState::Closed;
        if p.attached {
            self.on_close("transport close");
        }
    }

    fn on_poll(&mut self, rid: u64, reply: oneshot::Sender<PollReply>) {
        let Transport::Polling(p) = &mut self.transport else { return };
        if p.pending.is_some() {
            self.on_close("transport error"); // overlap from client
            let _ = reply.send(PollReply::Overlap);
            return;
        }
        p.pending = Some((rid, reply));
        self.flush();
        if let Transport::Polling(p) = &self.transport {
            if p.pending.is_some() && p.should_close.is_some() {
                self.transport_send(vec![Packet::Noop], false);
            }
        }
    }

    fn poll_on_data(&mut self, payload: &str) {
        for part in payload.split('\u{1e}') {
            if self.state == State::Closed {
                return;
            }
            let p = decode_packet(part);
            let is_err = matches!(p, Packet::Error);
            if let Packet::Close = p {
                self.poll_transport_closed();
            } else {
                self.on_packet(p);
            }
            if is_err {
                return;
            }
        }
    }

    fn on_ws(&mut self, ev: WsIn) {
        match ev {
            WsIn::Text(s) => self.on_packet(decode_packet(&s)),
            WsIn::Binary(b) => self.on_packet(Packet::Message(Msg::Binary(b))),
            WsIn::Closed => {
                let Transport::Ws(w) = &mut self.transport else { return };
                w.state = TState::Closed;
                if w.attached {
                    self.on_close("transport close");
                }
            }
            WsIn::Error(code) => {
                let Transport::Ws(w) = &mut self.transport else { return };
                if w.state == TState::Open {
                    let _ = w.out.send(WsOut::Close(code));
                    w.state = TState::Closing;
                }
                self.on_close("transport error");
            }
        }
    }

    fn on_upgrade_ws(&mut self, ev: WsIn) {
        let packet = match ev {
            WsIn::Text(s) => decode_packet(&s),
            WsIn::Binary(b) => Packet::Message(Msg::Binary(b)),
            WsIn::Closed => {
                self.upgrade = None;
                return;
            }
            WsIn::Error(code) => {
                if let Some(u) = self.upgrade.take() {
                    let _ = u.out.send(WsOut::Close(code));
                }
                return;
            }
        };
        match packet {
            Packet::Ping(Some(d)) if d == "probe" => {
                let u = self.upgrade.as_mut().unwrap();
                let _ = u.out.send(WsOut::Text("3probe".into()));
                u.check_at = Some(Instant::now() + UPGRADE_CHECK);
            }
            Packet::Upgrade if self.state != State::Closed => {
                let u = self.upgrade.take().unwrap();
                if let Transport::Polling(p) = &mut self.transport {
                    p.discarded = true;
                }
                self.upgraded = true;
                self.clear_transport();
                self.transport = Transport::Ws(Ws { tid: u.tid, out: u.out, binary: u.binary, state: TState::Open, attached: true });
                self.websocket.store(true, Ordering::Relaxed);
                self.flush();
                if self.state == State::Closing {
                    self.transport_close(CloseCb::ForcedClose);
                }
            }
            _ => {
                if let Some(u) = self.upgrade.take() {
                    let _ = u.out.send(WsOut::Close(None));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_and_encoding() {
        let q = search_params("/v1/updates/?EIO=4&transport=polling&t=a%20b+c&sid=1&sid=2&x=%zz");
        assert_eq!(q["EIO"], "4");
        assert_eq!(q["t"], "a b c");
        assert_eq!(q["sid"], "2");
        assert_eq!(q["x"], "%zz");
        let mut h = HeaderMap::new();
        h.insert("accept-encoding", "deflate, gzip".parse().unwrap());
        assert_eq!(pick_encoding(&h), Some("deflate"));
        h.insert("accept-encoding", "gzip;q=0.5, deflate".parse().unwrap());
        assert_eq!(pick_encoding(&h), Some("deflate"));
        h.insert("accept-encoding", "br".parse().unwrap());
        assert_eq!(pick_encoding(&h), None);
        h.insert("accept-encoding", "*".parse().unwrap());
        assert_eq!(pick_encoding(&h), Some("gzip"));
        assert!(ws_key_valid("dGhlIHNhbXBsZSBub25jZQ=="));
        assert!(!ws_key_valid("dGhlIHNhbXBsZSBub25jZQ="));
    }
}
