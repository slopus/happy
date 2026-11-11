//! A Fastify 5 look-alike on hyper: find-my-way style routing (static > param >
//! wildcard, no 405), `@fastify/cors` with origin `*`, the server's global JSON
//! body parser, fastify-type-provider-zod validation (params → body → querystring,
//! before auth), the `authenticate` preHandler, zod response schemas, the custom
//! error and not-found handlers, and automatic HEAD routes.

use crate::app::App;
use crate::js;
use crate::zod::{self, S};
use bytes::Bytes;
use futures_util::future::BoxFuture;
use http::{HeaderMap, Method, StatusCode};
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub type HResult = anyhow::Result<Reply>;
pub type Handler = fn(Arc<App>, Req) -> BoxFuture<'static, HResult>;

/// Wraps an `async fn(Arc<App>, Req) -> HResult` as a `Handler`.
#[macro_export]
macro_rules! h {
    ($f:path) => {{
        fn __h(a: std::sync::Arc<$crate::app::App>, r: $crate::http::Req) -> futures_util::future::BoxFuture<'static, $crate::http::HResult> {
            Box::pin($f(a, r))
        }
        __h as $crate::http::Handler
    }};
}

pub struct Req {
    pub method: Method,
    /// Raw request URL (path + query), as Fastify's `request.url`.
    pub url: String,
    pub headers: HeaderMap,
    pub params: Map<String, Value>,
    pub query: Map<String, Value>,
    /// Parsed body; `None` is `undefined`.
    pub body: Option<Value>,
    pub raw_body: Bytes,
    pub user_id: String,
    pub route: &'static str,
}

impl Req {
    pub fn param(&self, k: &str) -> String {
        self.params.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string()
    }
    pub fn body_field(&self, k: &str) -> Option<&Value> {
        js::get(self.body.as_ref(), k)
    }
    pub fn body_str(&self, k: &str) -> Option<String> {
        self.body_field(k).and_then(|v| v.as_str()).map(|s| s.to_string())
    }
    pub fn query_field(&self, k: &str) -> Option<&Value> {
        self.query.get(k)
    }
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers.get(k).and_then(|v| v.to_str().ok())
    }
}

pub enum Body {
    Json(Value),
    Text(String),
    Bytes(Vec<u8>, &'static str),
    Empty,
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl Reply {
    pub fn json(v: Value) -> HResult {
        Ok(Reply { status: 200, headers: vec![], body: Body::Json(v) })
    }
    pub fn code(status: u16, v: Value) -> HResult {
        Ok(Reply { status, headers: vec![], body: Body::Json(v) })
    }
    pub fn error(status: u16, msg: &str) -> HResult {
        Self::code(status, json!({ "error": msg }))
    }
    pub fn text(status: u16, s: &str) -> HResult {
        Ok(Reply { status, headers: vec![], body: Body::Text(s.to_string()) })
    }
    pub fn bytes(b: Vec<u8>) -> HResult {
        Ok(Reply { status: 200, headers: vec![], body: Body::Bytes(b, "application/octet-stream") })
    }
    pub fn redirect(url: &str) -> HResult {
        Ok(Reply { status: 302, headers: vec![("location".into(), url.to_string())], body: Body::Empty })
    }
    pub fn with_header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }
}

#[derive(Clone)]
enum Seg {
    Static(&'static str),
    Param(&'static str),
    Wildcard,
}

#[derive(Clone)]
pub struct Route {
    pub method: Method,
    pub pattern: &'static str,
    segs: Vec<Seg>,
    pub params: Option<S>,
    pub body: Option<S>,
    pub query: Option<S>,
    pub auth: bool,
    pub body_limit: usize,
    pub responses: Vec<(u16, S)>,
    pub handler: Handler,
}

pub struct RouteBuilder<'a> {
    router: &'a mut Router,
    route: Route,
}

impl<'a> RouteBuilder<'a> {
    pub fn params(mut self, s: S) -> Self {
        self.route.params = Some(s);
        self
    }
    pub fn body(mut self, s: S) -> Self {
        self.route.body = Some(s);
        self
    }
    pub fn query(mut self, s: S) -> Self {
        self.route.query = Some(s);
        self
    }
    pub fn auth(mut self) -> Self {
        self.route.auth = true;
        self
    }
    pub fn body_limit(mut self, n: usize) -> Self {
        self.route.body_limit = n;
        self
    }
    pub fn response(mut self, status: u16, s: S) -> Self {
        self.route.responses.push((status, s));
        self
    }
    pub fn handle(mut self, h: Handler) {
        self.route.handler = h;
        self.router.routes.push(Arc::new(self.route));
    }
}

pub const DEFAULT_BODY_LIMIT: usize = 100 * 1024 * 1024;

#[derive(Default)]
pub struct Router {
    pub routes: Vec<Arc<Route>>,
}

fn noop(_: Arc<App>, _: Req) -> BoxFuture<'static, HResult> {
    Box::pin(async { Reply::text(200, "") })
}

impl Router {
    pub fn add(&mut self, method: Method, pattern: &'static str) -> RouteBuilder<'_> {
        let segs = pattern[1..]
            .split('/')
            .map(|s| {
                if let Some(p) = s.strip_prefix(':') {
                    Seg::Param(p)
                } else if s == "*" {
                    Seg::Wildcard
                } else {
                    Seg::Static(s)
                }
            })
            .collect();
        RouteBuilder {
            router: self,
            route: Route {
                method,
                pattern,
                segs,
                params: None,
                body: None,
                query: None,
                auth: false,
                body_limit: DEFAULT_BODY_LIMIT,
                responses: vec![],
                handler: noop,
            },
        }
    }
    pub fn get(&mut self, p: &'static str) -> RouteBuilder<'_> {
        self.add(Method::GET, p)
    }
    pub fn post(&mut self, p: &'static str) -> RouteBuilder<'_> {
        self.add(Method::POST, p)
    }
    pub fn put(&mut self, p: &'static str) -> RouteBuilder<'_> {
        self.add(Method::PUT, p)
    }
    pub fn patch(&mut self, p: &'static str) -> RouteBuilder<'_> {
        self.add(Method::PATCH, p)
    }
    pub fn delete(&mut self, p: &'static str) -> RouteBuilder<'_> {
        self.add(Method::DELETE, p)
    }

    /// find-my-way lookup on the raw request URL: `safeDecodeURI` first (a
    /// malformed escape anywhere before `?`/`#` is a bad URL), then per segment
    /// static beats param beats wildcard, with backtracking. A param longer than
    /// `maxParamLength` (100) ends the search with no match.
    pub fn find(&self, method: &Method, url: &str) -> Lookup {
        let Some((path, decode_params)) = safe_decode_uri(url) else { return Lookup::BadUrl };
        let segs: Vec<&str> = path.get(1..).unwrap_or("").split('/').collect();
        let mut matches: Vec<(&Arc<Route>, Map<String, Value>, Vec<u8>, bool)> = Vec::new();
        for r in self.routes.iter().filter(|r| &r.method == method) {
            if let Some((params, rank, too_long)) = match_route(&r.segs, &segs, decode_params) {
                matches.push((r, params, rank, too_long));
            }
        }
        // Lexicographically larger rank = more specific (static=2, param=1, wildcard=0).
        matches.sort_by(|a, b| b.2.cmp(&a.2));
        match matches.into_iter().next() {
            Some((_, _, _, true)) | None => Lookup::NotFound,
            Some((r, p, _, false)) => Lookup::Found(r.clone(), p),
        }
    }
}

pub enum Lookup {
    Found(Arc<Route>, Map<String, Value>),
    NotFound,
    BadUrl,
}

const MAX_PARAM_LENGTH: usize = 100;

fn match_route(pat: &[Seg], segs: &[&str], decode_params: bool) -> Option<(Map<String, Value>, Vec<u8>, bool)> {
    let mut params = Map::new();
    let mut rank = Vec::new();
    let mut too_long = false;
    let decode = |s: &str| if decode_params { safe_decode_uri_component(s) } else { s.to_string() };
    for (i, p) in pat.iter().enumerate() {
        match p {
            Seg::Wildcard => {
                params.insert("*".into(), Value::String(decode(&segs[i.min(segs.len())..].join("/"))));
                rank.push(0);
                return Some((params, rank, too_long));
            }
            Seg::Static(s) => {
                if segs.get(i)? != s {
                    return None;
                }
                rank.push(2);
            }
            Seg::Param(name) => {
                // find-my-way accepts an empty param (`/v1/sessions//messages`).
                let seg = segs.get(i)?;
                let v = decode(seg);
                if v.encode_utf16().count() > MAX_PARAM_LENGTH {
                    too_long = true;
                }
                params.insert(name.to_string(), Value::String(v));
                rank.push(1);
            }
        }
    }
    if pat.len() != segs.len() {
        return None;
    }
    Some((params, rank, too_long))
}

/// The characters `decodeURIComponent` decodes but `decodeURI` keeps
/// (find-my-way `decodeComponentChar`).
fn component_char(h: u8, l: u8) -> Option<char> {
    match (h, l) {
        (b'2', b'5') => Some('%'),
        (b'2', b'3') => Some('#'),
        (b'2', b'4') => Some('$'),
        (b'2', b'6') => Some('&'),
        (b'2', b'B') | (b'2', b'b') => Some('+'),
        (b'2', b'C') | (b'2', b'c') => Some(','),
        (b'2', b'F') | (b'2', b'f') => Some('/'),
        (b'3', b'A') | (b'3', b'a') => Some(':'),
        (b'3', b'B') | (b'3', b'b') => Some(';'),
        (b'3', b'D') | (b'3', b'd') => Some('='),
        (b'3', b'F') | (b'3', b'f') => Some('?'),
        (b'4', b'0') => Some('@'),
        _ => None,
    }
}

/// find-my-way `safeDecodeURI`: the path before `?`/`#`, run through `decodeURI`
/// when it has escapes other than reserved characters. `None` when `decodeURI`
/// throws. The flag says whether params still need `safeDecodeURIComponent`.
fn safe_decode_uri(url: &str) -> Option<(String, bool)> {
    let b = url.as_bytes();
    let mut path: Vec<u8> = Vec::with_capacity(b.len());
    let mut should_decode = false;
    let mut should_decode_param = false;
    if !b.is_empty() {
        path.push(b[0]);
    }
    let mut i = 1;
    while i < b.len() {
        let c = b[i];
        if c == b'%' {
            let h = b.get(i + 1).copied().unwrap_or(0);
            let l = b.get(i + 2).copied().unwrap_or(0);
            if component_char(h, l).is_none() {
                should_decode = true;
                path.push(c);
                i += 1;
            } else {
                should_decode_param = true;
                if h == b'2' && l == b'5' {
                    // Keep `%25` encoded through decodeURI.
                    should_decode = true;
                    path.extend_from_slice(b"%2525");
                } else {
                    path.extend_from_slice(&b[i..i + 3]);
                }
                i += 3;
            }
        } else if c == b'?' || c == b'#' {
            break;
        } else {
            path.push(c);
            i += 1;
        }
    }
    let path = String::from_utf8(path).ok()?;
    let path = if should_decode { decode_uri(&path)? } else { path };
    Some((path, should_decode_param))
}

/// ECMAScript `decodeURI`: `None` where it throws `URIError`.
pub fn decode_uri(s: &str) -> Option<String> {
    const RESERVED: &[u8] = b";/?:@&=+$,#";
    let b = s.as_bytes();
    let hex = |i: usize| -> Option<u8> {
        if b.get(i) != Some(&b'%') {
            return None;
        }
        let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
        if !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        u8::from_str_radix(h, 16).ok()
    };
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = hex(i)?;
        if first < 0x80 {
            if RESERVED.contains(&first) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let n = if first & 0xE0 == 0xC0 {
            2
        } else if first & 0xF0 == 0xE0 {
            3
        } else if first & 0xF8 == 0xF0 {
            4
        } else {
            return None;
        };
        let mut bytes = vec![first];
        for k in 1..n {
            let x = hex(i + 3 * k)?;
            if x & 0xC0 != 0x80 {
                return None;
            }
            bytes.push(x);
        }
        // Rejects overlong forms, surrogates and code points above U+10FFFF.
        out.extend_from_slice(std::str::from_utf8(&bytes).ok()?.as_bytes());
        i += 3 * n;
    }
    String::from_utf8(out).ok()
}

/// find-my-way `safeDecodeURIComponent`: decodes the reserved-character escapes
/// `decodeURI` left behind. An escape it does not know becomes the text "null".
fn safe_decode_uri_component(s: &str) -> String {
    let Some(start) = s.find('%') else { return s.to_string() };
    let b = s.as_bytes();
    let mut decoded = String::new();
    let mut last = start;
    let mut i = start;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1).copied().unwrap_or(0);
            let l = b.get(i + 2).copied().unwrap_or(0);
            decoded.push_str(&s[last..i]);
            match component_char(h, l) {
                Some(c) => decoded.push(c),
                None => decoded.push_str("null"),
            }
            last = (i + 3).min(b.len());
        }
        i += 1;
    }
    format!("{}{}{}", &s[..start], decoded, &s[last..])
}

/// Fastify's `onBadUrl` answer, written before any hook runs (no CORS header).
pub fn bad_url(url: &str) -> HttpResponse {
    let body = js::stringify(&json!({
        "error": "Bad Request",
        "code": "FST_ERR_BAD_URL",
        "message": format!("'{}' is not a valid url component", url),
        "statusCode": 400,
    }));
    hyper::Response::builder()
        .status(400)
        .header("content-type", "application/json")
        .header("content-length", body.len().to_string())
        .body(RespBody::full(Bytes::from(body)))
        .unwrap()
}

/// `fast-decode-uri-component`: `None` on malformed escapes / invalid UTF-8.
pub fn decode_component(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            let v = u8::from_str_radix(h, 16).ok()?;
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `fast-querystring` parse.
pub fn parse_query(input: &str) -> Map<String, Value> {
    let mut result = Map::new();
    for part in input.split('&') {
        let (k, v, has_eq) = match part.find('=') {
            Some(i) => (&part[..i], &part[i + 1..], true),
            None => (part, "", false),
        };
        if !has_eq && k.is_empty() {
            continue;
        }
        let fix = |s: &str| -> String {
            let s = s.replace('+', " ");
            if s.contains('%') {
                match decode_component(&s) {
                    Some(d) if !d.is_empty() => d,
                    _ => s,
                }
            } else {
                s
            }
        };
        let key = fix(k);
        let val = if has_eq { fix(v) } else { String::new() };
        match result.get_mut(&key) {
            None => {
                result.insert(key, Value::String(val));
            }
            Some(Value::Array(a)) => a.push(Value::String(val)),
            Some(cur) => {
                let prev = cur.take();
                *cur = Value::Array(vec![prev, Value::String(val)]);
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

pub type HttpResponse = hyper::Response<RespBody>;

/// A response body sent in one piece: with a length, or chunked like Node does
/// for `res.writeHead(...)` followed by `res.end(data)`.
pub struct RespBody {
    data: Option<Bytes>,
    chunked: bool,
}

impl RespBody {
    pub fn full(b: Bytes) -> RespBody {
        RespBody { data: Some(b), chunked: false }
    }

    pub fn chunked(b: Bytes) -> RespBody {
        RespBody { data: Some(b), chunked: true }
    }
}

impl hyper::body::Body for RespBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        let d = self.get_mut().data.take().filter(|d| !d.is_empty());
        std::task::Poll::Ready(d.map(|d| Ok(hyper::body::Frame::data(d))))
    }

    fn is_end_stream(&self) -> bool {
        !self.chunked && self.data.as_ref().is_none_or(|d| d.is_empty())
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        if self.chunked {
            hyper::body::SizeHint::default()
        } else {
            hyper::body::SizeHint::with_exact(self.data.as_ref().map(|d| d.len() as u64).unwrap_or(0))
        }
    }
}

fn base_response(status: u16) -> http::response::Builder {
    hyper::Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)).header("access-control-allow-origin", "*")
}

pub fn render(reply: Reply) -> HttpResponse {
    let mut b = base_response(reply.status);
    let mut has_ct = false;
    for (k, v) in &reply.headers {
        if k.eq_ignore_ascii_case("content-type") {
            has_ct = true;
        }
        b = b.header(k.as_str(), v.as_str());
    }
    let (ct, bytes) = match reply.body {
        Body::Json(v) => (Some("application/json; charset=utf-8"), Bytes::from(js::stringify(&v))),
        Body::Text(s) => (Some("text/plain; charset=utf-8"), Bytes::from(s)),
        Body::Bytes(b, ct) => (Some(ct), Bytes::from(b)),
        Body::Empty => (None, Bytes::new()),
    };
    if let (Some(ct), false) = (ct, has_ct) {
        b = b.header("content-type", ct);
    }
    b = b.header("content-length", bytes.len().to_string());
    b.body(RespBody::full(bytes)).unwrap()
}

/// Fastify error handler output.
pub fn error_reply(status: u16, name: &str, message: &str) -> Reply {
    if status >= 500 {
        Reply {
            status,
            headers: vec![],
            body: Body::Json(json!({"error":"Internal Server Error","message":"An unexpected error occurred","statusCode":status})),
        }
    } else {
        Reply { status, headers: vec![], body: Body::Json(json!({"error":name,"message":message,"statusCode":status})) }
    }
}

pub fn not_found(method: &Method, url: &str) -> Reply {
    Reply { status: 404, headers: vec![], body: Body::Json(json!({"error":"Not found","path":url,"method":method.as_str()})) }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

fn has_body_method(m: &Method) -> bool {
    !(m == Method::GET || m == Method::HEAD)
}

enum Parsed {
    Ok(Option<Value>, Bytes),
    Err(Reply),
}

async fn read_body(req: hyper::Request<Incoming>, limit: usize) -> Result<(http::request::Parts, Bytes), Reply> {
    let (parts, body) = req.into_parts();
    if let Some(cl) = parts.headers.get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()) {
        if cl > limit {
            return Err(error_reply(413, "FastifyError", "Request body is too large"));
        }
    }
    match Limited::new(body, limit).collect().await {
        Ok(c) => Ok((parts, c.to_bytes())),
        Err(e) => {
            if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                Err(error_reply(413, "FastifyError", "Request body is too large"))
            } else {
                Err(error_reply(400, "Error", "aborted"))
            }
        }
    }
}

fn parse_body(method: &Method, headers: &HeaderMap, raw: Bytes) -> Parsed {
    if !has_body_method(method) {
        return Parsed::Ok(None, raw);
    }
    let ct = headers.get("content-type").and_then(|v| v.to_str().ok());
    let Some(ct) = ct else {
        let te = headers.contains_key("transfer-encoding");
        let cl = headers.get("content-length").and_then(|v| v.to_str().ok());
        if !te && (cl.is_none() || cl == Some("0")) {
            return Parsed::Ok(None, raw);
        }
        return Parsed::Err(error_reply(415, "FastifyError", "Unsupported Media Type: undefined"));
    };
    let media = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match media.as_str() {
        "application/json" => {
            let s = String::from_utf8_lossy(&raw).into_owned();
            if s.trim().is_empty() {
                // connectRoutes' parser: undefined for DELETE/GET, {} otherwise.
                if method == Method::DELETE || method == Method::GET {
                    return Parsed::Ok(None, raw);
                }
                return Parsed::Ok(Some(Value::Object(Map::new())), raw);
            }
            match js::parse(&s) {
                Ok(v) => Parsed::Ok(Some(v), raw),
                Err(e) => Parsed::Err(error_reply(400, "SyntaxError", &e.message)),
            }
        }
        "text/plain" => Parsed::Ok(Some(Value::String(String::from_utf8_lossy(&raw).into_owned())), raw),
        // A Buffer validates like an object without named keys.
        "application/octet-stream" => Parsed::Ok(Some(Value::Object(Map::new())), raw),
        _ => Parsed::Err(error_reply(415, "FastifyError", &format!("Unsupported Media Type: {}", ct))),
    }
}

/// Entry point for the API listener: Engine.IO owns its path and every upgrade.
pub async fn serve(app: Arc<App>, req: hyper::Request<Incoming>) -> Result<HttpResponse, crate::engine::Destroy> {
    let path = req.uri().path();
    if crate::engine::is_engine_path(path) {
        return crate::engine::handle(app, req).await;
    }
    if crate::engine::is_upgrade(req.headers()) {
        // Node routes it to the 'upgrade' listener, which ends the socket after 1 s.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        return Err(crate::engine::Destroy);
    }
    Ok(handle(app, req).await)
}

pub async fn handle(app: Arc<App>, req: hyper::Request<Incoming>) -> HttpResponse {
    let started = std::time::Instant::now();
    let method = req.method().clone();
    let url = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| req.uri().path().to_string());
    let client = req.headers().get("x-happy-client").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let (route_label, resp) = dispatch(app.clone(), req, method.clone(), url.clone()).await;
    let status = resp.status().as_u16();
    if route_label.is_empty() {
        return resp; // bad URL: answered before Fastify's hooks
    }
    app.metrics.observe_http(method.as_str(), &route_label, status, client.as_deref(), started.elapsed().as_secs_f64());
    resp
}

async fn dispatch(app: Arc<App>, req: hyper::Request<Incoming>, method: Method, url: String) -> (String, HttpResponse) {
    let (path, query_str) = match url.find('?') {
        Some(i) => (url[..i].to_string(), url[i + 1..].to_string()),
        None => (url.clone(), String::new()),
    };

    // CORS preflight (`@fastify/cors`, strictPreflight).
    if method == Method::OPTIONS {
        let h = req.headers();
        if h.contains_key("origin") && h.contains_key("access-control-request-method") {
            let resp = base_response(204)
                .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE")
                .header("access-control-allow-headers", "*")
                .header("content-length", "0")
                .body(RespBody::full(Bytes::new()))
                .unwrap();
            return ("*".into(), resp);
        }
        return (
            "*".into(),
            render(Reply {
                status: 400,
                headers: vec![("content-type".into(), "text/plain".into())],
                body: Body::Text("Invalid Preflight Request".into()),
            }),
        );
    }

    let lookup_method = if method == Method::HEAD { Method::GET } else { method.clone() };
    let (route, params) = match app.router.find(&lookup_method, &url) {
        Lookup::Found(r, p) => (r, p),
        Lookup::BadUrl => return (String::new(), bad_url(&url)),
        Lookup::NotFound => return (path, render(not_found(&method, &url))),
    };
    let label = route.pattern.to_string();
    let (parts, raw) = match read_body(req, route.body_limit).await {
        Ok(x) => x,
        Err(r) => return (label, render(finalize(&route, r, Origin::ErrorHandler))),
    };
    // Large JSON bodies (up to 100 MB) are parsed off the reactor threads.
    let parsed = if raw.len() > 256 * 1024 {
        let (m, h) = (method.clone(), parts.headers.clone());
        match tokio::task::spawn_blocking(move || parse_body(&m, &h, raw)).await {
            Ok(p) => p,
            Err(_) => Parsed::Err(error_reply(500, "Error", "")),
        }
    } else {
        parse_body(&method, &parts.headers, raw)
    };
    let (body, raw) = match parsed {
        Parsed::Ok(b, r) => (b, r),
        Parsed::Err(r) => return (label, render(finalize(&route, r, Origin::ErrorHandler))),
    };
    let query = parse_query(&query_str);

    // Validation: params → body → querystring.
    let mut params = Value::Object(params);
    let mut body = body;
    let mut query = Value::Object(query);
    if let Some(s) = &route.params {
        match s.parse(Some(&params)) {
            Ok(v) => params = v.unwrap_or(Value::Object(Map::new())),
            Err(i) => return (label, render(finalize(&route, error_reply(400, "Error", &zod::format_issues("params", &i)), Origin::ErrorHandler))),
        }
    }
    if let Some(s) = &route.body {
        match s.parse(body.as_ref()) {
            Ok(v) => body = v,
            Err(i) => return (label, render(finalize(&route, error_reply(400, "Error", &zod::format_issues("body", &i)), Origin::ErrorHandler))),
        }
    }
    if let Some(s) = &route.query {
        match s.parse(Some(&query)) {
            Ok(v) => query = v.unwrap_or(Value::Object(Map::new())),
            Err(i) => return (label, render(finalize(&route, error_reply(400, "Error", &zod::format_issues("querystring", &i)), Origin::ErrorHandler))),
        }
    }

    // preHandler: authenticate.
    let mut user_id = String::new();
    if route.auth {
        let h = parts.headers.get("authorization").and_then(|v| v.to_str().ok());
        match h {
            Some(h) if h.starts_with("Bearer ") => match app.auth.verify_token(&h[7..]) {
                Some(u) => user_id = u,
                None => {
                    let r = Reply { status: 401, headers: vec![], body: Body::Json(json!({"error":"Invalid token"})) };
                    return (label, render(finalize(&route, r, Origin::Handler)));
                }
            },
            _ => {
                let r = Reply { status: 401, headers: vec![], body: Body::Json(json!({"error":"Missing authorization header"})) };
                return (label, render(finalize(&route, r, Origin::Handler)));
            }
        }
    }

    let r = Req {
        method: method.clone(),
        url: url.clone(),
        headers: parts.headers,
        params: params.as_object().cloned().unwrap_or_default(),
        query: query.as_object().cloned().unwrap_or_default(),
        body,
        raw_body: raw,
        user_id,
        route: route.pattern,
    };
    let reply = match (route.handler)(app.clone(), r).await {
        Ok(rep) => finalize(&route, rep, Origin::Handler),
        Err(e) => {
            tracing::error!(route = route.pattern, method = %method, "http:error {:#}", e);
            finalize(&route, error_reply(500, "Error", ""), Origin::ErrorHandler)
        }
    };
    (label, render(reply))
}

#[derive(PartialEq, Clone, Copy)]
enum Origin {
    /// `reply.send` from a handler or preHandler.
    Handler,
    /// Sent by the custom error handler (validation, parser and thrown errors).
    ErrorHandler,
}

/// Response serialization (fastify-type-provider-zod) and what Fastify does when it
/// fails. A handler payload that does not match its status schema throws
/// `FST_ERR_RESPONSE_SERIALIZATION` (500) into the custom error handler; if the
/// error handler's own payload fails its schema too, Fastify's default handler and
/// then the fallback error serializer answer.
fn finalize(route: &Route, reply: Reply, origin: Origin) -> Reply {
    let Body::Json(v) = &reply.body else { return reply };
    let Some((_, s)) = route.responses.iter().find(|(st, _)| *st == reply.status) else { return reply };
    match s.parse(Some(v)) {
        Ok(Some(out)) => Reply { body: Body::Json(out), ..reply },
        Ok(None) => reply,
        Err(i) => {
            tracing::error!(route = route.pattern, "response serialization failed: {}", zod::format_issues("response", &i));
            match origin {
                Origin::Handler => finalize(route, error_reply(500, "Error", ""), Origin::ErrorHandler),
                Origin::ErrorHandler => fallback_error(route),
            }
        }
    }
}

const RSE_MESSAGE: &str = "Response doesn't match the schema";

/// Fastify `fallbackErrorHandler` for the response serialization error.
fn fallback_error(route: &Route) -> Reply {
    let body = match route.responses.iter().find(|(st, _)| *st == 500) {
        Some((_, s)) => {
            let input = json!({
                "error": "Internal Server Error",
                "message": RSE_MESSAGE,
                "statusCode": 500,
                "code": "FST_ERR_RESPONSE_SERIALIZATION",
                "name": "FastifyError",
            });
            match s.parse(Some(&input)) {
                Ok(Some(out)) => out,
                _ => json!({
                    "statusCode": 500,
                    "code": "FST_ERR_FAILED_ERROR_SERIALIZATION",
                    "message": format!("Failed to serialize an error. Error: {}. Original error: {}", RSE_MESSAGE, RSE_MESSAGE),
                }),
            }
        }
        None => json!({
            "statusCode": 500,
            "code": "FST_ERR_RESPONSE_SERIALIZATION",
            "error": "Internal Server Error",
            "message": RSE_MESSAGE,
        }),
    };
    Reply { status: 500, headers: vec![], body: Body::Json(body) }
}

/// Header helper: first value of a possibly repeated header (`x-forwarded-*`).
pub fn first_header(h: &HeaderMap, k: &str) -> Option<String> {
    h.get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_uri_like_js() {
        assert_eq!(decode_uri("/a%41%2F%E2%82%AC").as_deref(), Some("/aA%2F€"));
        assert_eq!(decode_uri("/%E0%A4%A"), None);
        assert_eq!(decode_uri("/%C0%80"), None);
        assert_eq!(decode_uri("/%ED%A0%80"), None);
        assert_eq!(decode_uri("/%zz"), None);
        assert_eq!(safe_decode_uri("/a%2Fb/%25x?q=%zz").unwrap(), ("/a%2Fb/%25x".to_string(), true));
        assert_eq!(safe_decode_uri_component("a%2Fb%25"), "a/b%");
    }

    #[test]
    fn query_like_fast_querystring() {
        let q = parse_query("a=1&a=2&b=x+y&c=%41&d&=e&f=%E0%A4%A&g=a=b");
        assert_eq!(js::stringify(&Value::Object(q)), r#"{"a":["1","2"],"b":"x y","c":"A","d":"","":"e","f":"%E0%A4%A","g":"a=b"}"#);
    }
}
