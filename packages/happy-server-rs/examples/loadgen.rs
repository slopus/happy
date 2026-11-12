//! Load generator for the TS and Rust servers alike (Phase 4 numbers).
//!
//!   cargo run --release --example loadgen -- <host:port> <scenario>
//!
//! Scenarios (parameters from the environment):
//! - `sockets`: SOCKETS user-scoped sockets over ACCOUNTS accounts, CONCURRENCY
//!   handshakes at a time; handshake/s and TCP connect → `40{sid}` latency. With
//!   SERVER_PID, the server's RSS before and while they are all open.
//! - `fanout`: ACCOUNTS accounts, each one session-scoped sender and LISTENERS
//!   user-scoped sockets; senders keep WINDOW `message` events in flight (one is
//!   done when every listener has its `new-message` update). Messages/s,
//!   deliveries/s and send → delivery latency, over DURATION seconds after WARMUP.
//! - `rpc`: PAIRS accounts, each a machine-scoped daemon answering `rpc-request`
//!   and a user-scoped caller keeping WINDOW `rpc-call`s in flight. Calls/s and
//!   call → ack round trip.
//!
//! Prints one JSON line per scenario.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::Engine;
use ed25519_dalek::Signer;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio_tungstenite::tungstenite::Message;

fn env(k: &str, d: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// An authenticated account: a deterministic key per index.
async fn token(http: &reqwest::Client, addr: &str, n: u64) -> Result<String> {
    let mut seed = [0x5au8; 32];
    seed[..8].copy_from_slice(&n.to_le_bytes());
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let challenge: [u8; 32] = rand::random();
    let sig = key.sign(&challenge);
    let body = json!({ "publicKey": b64(key.verifying_key().as_bytes()), "challenge": b64(&challenge), "signature": b64(&sig.to_bytes()) });
    let r: Value = http.post(format!("http://{addr}/v1/auth")).json(&body).send().await?.json().await?;
    Ok(r["token"].as_str().context("no token")?.to_string())
}

async fn new_session(http: &reqwest::Client, addr: &str, token: &str, tag: &str) -> Result<String> {
    let r: Value = http
        .post(format!("http://{addr}/v1/sessions"))
        .bearer_auth(token)
        .json(&json!({ "tag": tag, "metadata": "m" }))
        .send()
        .await?
        .json()
        .await?;
    Ok(r["session"]["id"].as_str().context("no session")?.to_string())
}

/// One Socket.IO client: text frames out through `tx`, frames in through `rx`
/// (pings are answered by the connection task).
struct Conn {
    tx: mpsc::UnboundedSender<String>,
    rx: mpsc::UnboundedReceiver<String>,
}

type Stream = futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<TcpStream>>;

async fn next_text(stream: &mut Stream) -> Result<String> {
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(t))) => return Ok(t.to_string()),
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => bail!("closed"),
        }
    }
}

async fn connect(addr: &str, auth: &Value) -> Result<Conn> {
    let tcp = TcpStream::connect(addr).await?;
    tcp.set_nodelay(true)?;
    let (ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}/v1/updates/?EIO=4&transport=websocket"), tcp).await?;
    let (mut sink, mut stream) = ws.split();
    let open = next_text(&mut stream).await?;
    if !open.starts_with('0') {
        bail!("unexpected open {open}");
    }
    sink.send(Message::text(format!("40{auth}"))).await?;
    let ok = next_text(&mut stream).await?;
    if !ok.starts_with("40") {
        bail!("refused {ok}");
    }
    let (tx, mut out) = mpsc::unbounded_channel::<String>();
    let (inp, rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                m = out.recv() => match m {
                    Some(m) => if sink.send(Message::text(m)).await.is_err() { break },
                    None => { let _ = sink.send(Message::Close(None)).await; break }
                },
                m = stream.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        if t.as_str() == "2" {
                            if sink.send(Message::text("3")).await.is_err() { break }
                        } else if inp.send(t.to_string()).is_err() {
                            // Nobody reads this socket's events; keep it open.
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                },
            }
        }
    });
    Ok(Conn { tx, rx })
}

fn rss_kb(pid: u64) -> Option<u64> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    s.lines().find(|l| l.starts_with("VmRSS:"))?.split_whitespace().nth(1)?.parse().ok()
}

fn pct(v: &mut [u64], p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_unstable();
    let i = ((v.len() as f64 - 1.0) * p).round() as usize;
    v[i] as f64 / 1000.0 // µs → ms
}

async fn accounts(http: &reqwest::Client, addr: &str, n: u64) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for i in 0..n {
        out.push(token(http, addr, i).await?);
    }
    Ok(out)
}

async fn sockets(addr: String, http: reqwest::Client) -> Result<Value> {
    let (n, conc, accs) = (env("SOCKETS", 2000), env("CONCURRENCY", 100), env("ACCOUNTS", 50));
    let pid = std::env::var("SERVER_PID").ok().and_then(|p| p.parse::<u64>().ok());
    let tokens = Arc::new(accounts(&http, &addr, accs).await?);
    let rss_before = pid.and_then(rss_kb);
    let sem = Arc::new(Semaphore::new(conc as usize));
    let held = Arc::new(Mutex::new(Vec::new()));
    let lat = Arc::new(Mutex::new(Vec::new()));
    let failed = Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for i in 0..n {
        let (addr, tokens, sem, held, lat, failed) = (addr.clone(), tokens.clone(), sem.clone(), held.clone(), lat.clone(), failed.clone());
        tasks.push(tokio::spawn(async move {
            let _p = sem.acquire().await.unwrap();
            let auth = json!({ "token": tokens[(i % tokens.len() as u64) as usize], "clientType": "user-scoped", "happyClient": "loadgen/1" });
            let s = Instant::now();
            match connect(&addr, &auth).await {
                Ok(c) => {
                    lat.lock().await.push(s.elapsed().as_micros() as u64);
                    held.lock().await.push(c);
                }
                Err(_) => {
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for t in tasks {
        t.await?;
    }
    let secs = t0.elapsed().as_secs_f64();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let rss_open = pid.and_then(rss_kb);
    let open = held.lock().await.len();
    held.lock().await.clear();
    let mut l = lat.lock().await;
    Ok(json!({
        "scenario": "sockets", "sockets": n, "concurrency": conc, "open": open, "failed": failed.load(Ordering::Relaxed),
        "ops_per_s": (open as f64 / secs).round(), "p50_ms": pct(&mut l, 0.5), "p99_ms": pct(&mut l, 0.99),
        "rss_mb_before": rss_before.map(|k| k / 1024), "rss_mb_open": rss_open.map(|k| k / 1024),
    }))
}

/// Pulls the `lg:<k>:<µs>` marker out of a `new-message` update without a JSON parse.
fn marker(frame: &str) -> Option<(u64, u64)> {
    let i = frame.find("\"c\":\"lg:")? + 8;
    let rest = &frame[i..];
    let mut it = rest.split(|c: char| c == ':' || c == '"');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

async fn fanout(addr: String, http: reqwest::Client) -> Result<Value> {
    let (accs, listeners, window) = (env("ACCOUNTS", 20), env("LISTENERS", 10), env("WINDOW", 4));
    let (warm, dur) = (Duration::from_secs(env("WARMUP", 3)), Duration::from_secs(env("DURATION", 15)));
    let tokens = accounts(&http, &addr, accs).await?;
    let t0 = Arc::new(Instant::now());
    let stop = Arc::new(AtomicBool::new(false));
    let lat = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicU64::new(0));
    let delivered = Arc::new(AtomicU64::new(0));
    let mut setup = Vec::new();
    for (a, tok) in tokens.iter().enumerate() {
        let sid = new_session(&http, &addr, tok, &format!("lg-{a}")).await?;
        let sender = connect(&addr, &json!({ "token": tok, "clientType": "session-scoped", "sessionId": sid, "happyClient": "loadgen/1" })).await?;
        let (dtx, drx) = mpsc::unbounded_channel::<(u64, u64)>();
        for _ in 0..listeners {
            let mut c = connect(&addr, &json!({ "token": tok, "clientType": "user-scoped", "happyClient": "loadgen/1" })).await?;
            let dtx = dtx.clone();
            let t0 = t0.clone();
            tokio::spawn(async move {
                let _keep = c.tx;
                while let Some(f) = c.rx.recv().await {
                    if let Some((k, sent)) = marker(&f) {
                        let now = t0.elapsed().as_micros() as u64;
                        let _ = dtx.send((k, now.saturating_sub(sent)));
                    }
                }
            });
        }
        drop(dtx);
        setup.push((sid, sender, drx));
    }
    let base = t0.elapsed();
    let mut senders = Vec::new();
    for (sid, sender, mut drx) in setup {
        let (t0, stop, done, delivered) = (t0.clone(), stop.clone(), done.clone(), delivered.clone());
        senders.push(tokio::spawn(async move {
            let mut counts: HashMap<u64, u64> = HashMap::new();
            let mut sent_at: HashMap<u64, u64> = HashMap::new();
            let (mut k, mut inflight) = (0u64, 0u64);
            let (w0, w1) = ((base + warm).as_micros() as u64, (base + warm + dur).as_micros() as u64);
            let mut local = Vec::new();
            loop {
                while inflight < window && !stop.load(Ordering::Relaxed) {
                    let now = t0.elapsed().as_micros() as u64;
                    let frame = format!("42{}", json!(["message", { "sid": sid, "message": format!("lg:{k}:{now}") }]));
                    if sender.tx.send(frame).is_err() {
                        return local;
                    }
                    sent_at.insert(k, now);
                    k += 1;
                    inflight += 1;
                }
                if inflight == 0 {
                    return local;
                }
                let Ok(Some((m, l))) = tokio::time::timeout(Duration::from_secs(10), drx.recv()).await else { return local };
                let at = sent_at.get(&m).copied().unwrap_or(0);
                let measured = at >= w0 && at < w1;
                if measured {
                    local.push(l);
                    delivered.fetch_add(1, Ordering::Relaxed);
                }
                let c = counts.entry(m).or_insert(0);
                *c += 1;
                if *c == listeners {
                    counts.remove(&m);
                    sent_at.remove(&m);
                    inflight -= 1;
                    if measured {
                        done.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }));
    }
    tokio::time::sleep(warm + dur).await;
    stop.store(true, Ordering::Relaxed);
    for s in senders {
        let v = s.await?;
        lat.lock().await.extend(v);
    }
    let secs = dur.as_secs_f64();
    let mut l = lat.lock().await;
    Ok(json!({
        "scenario": "fanout", "accounts": accs, "listeners": listeners, "window": window,
        "ops_per_s": (done.load(Ordering::Relaxed) as f64 / secs).round(),
        "deliveries_per_s": (delivered.load(Ordering::Relaxed) as f64 / secs).round(),
        "p50_ms": pct(&mut l, 0.5), "p99_ms": pct(&mut l, 0.99),
    }))
}

/// `42<id>["rpc-request",…]` → `<id>`.
fn request_ack(frame: &str) -> Option<&str> {
    let rest = frame.strip_prefix("42")?;
    let i = rest.find('[')?;
    rest[i..].starts_with("[\"rpc-request\"").then(|| &rest[..i])
}

async fn rpc(addr: String, http: reqwest::Client) -> Result<Value> {
    let (pairs, window) = (env("PAIRS", 20), env("WINDOW", 4));
    let (warm, dur) = (Duration::from_secs(env("WARMUP", 3)), Duration::from_secs(env("DURATION", 15)));
    let tokens = accounts(&http, &addr, pairs).await?;
    let stop = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicU64::new(0));
    let mut setup = Vec::new();
    for (i, tok) in tokens.iter().enumerate() {
        let method = format!("m{i}:echo");
        let mut daemon = connect(&addr, &json!({ "token": tok, "clientType": "machine-scoped", "machineId": format!("m{i}") })).await?;
        daemon.tx.send(format!("42{}", json!(["rpc-register", { "method": method }])))?;
        loop {
            let f = daemon.rx.recv().await.context("daemon closed")?;
            if f.starts_with("42[\"rpc-registered\"") {
                break;
            }
        }
        tokio::spawn(async move {
            while let Some(f) = daemon.rx.recv().await {
                if let Some(id) = request_ack(&f) {
                    let _ = daemon.tx.send(format!("43{id}[\"pong\"]"));
                }
            }
        });
        let caller = connect(&addr, &json!({ "token": tok, "clientType": "user-scoped", "happyClient": "loadgen/1" })).await?;
        setup.push((method, caller));
    }
    let t0 = Instant::now();
    let mut callers = Vec::new();
    for (method, mut caller) in setup {
        let (stop, done, failed) = (stop.clone(), done.clone(), failed.clone());
        callers.push(tokio::spawn(async move {
            let mut sent: HashMap<u64, Instant> = HashMap::new();
            let (mut id, mut local) = (0u64, Vec::new());
            loop {
                while (sent.len() as u64) < window && !stop.load(Ordering::Relaxed) {
                    let frame = format!("42{id}{}", json!(["rpc-call", { "method": method, "params": "ping" }]));
                    if caller.tx.send(frame).is_err() {
                        return local;
                    }
                    sent.insert(id, Instant::now());
                    id += 1;
                }
                if sent.is_empty() {
                    return local;
                }
                let Ok(Some(f)) = tokio::time::timeout(Duration::from_secs(35), caller.rx.recv()).await else { return local };
                let Some(rest) = f.strip_prefix("43") else { continue };
                let Some(end) = rest.find('[') else { continue };
                let Ok(ack) = rest[..end].parse::<u64>() else { continue };
                let Some(s) = sent.remove(&ack) else { continue };
                let at = s.duration_since(t0);
                if at >= warm && at < warm + dur {
                    if rest[end..].contains("\"ok\":true") {
                        local.push(s.elapsed().as_micros() as u64);
                        done.fetch_add(1, Ordering::Relaxed);
                    } else {
                        failed.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }));
    }
    tokio::time::sleep(warm + dur).await;
    stop.store(true, Ordering::Relaxed);
    let mut l = Vec::new();
    for c in callers {
        l.extend(c.await?);
    }
    Ok(json!({
        "scenario": "rpc", "pairs": pairs, "window": window,
        "ops_per_s": (done.load(Ordering::Relaxed) as f64 / dur.as_secs_f64()).round(), "failed": failed.load(Ordering::Relaxed),
        "p50_ms": pct(&mut l, 0.5), "p99_ms": pct(&mut l, 0.99),
    }))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (addr, scenario) = (args.get(1).context("host:port")?.clone(), args.get(2).context("scenario")?.clone());
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(env("LOADGEN_THREADS", 8) as usize).enable_all().build()?;
    rt.block_on(async move {
        let http = reqwest::Client::new();
        let out = match scenario.as_str() {
            "sockets" => sockets(addr, http).await?,
            "fanout" => fanout(addr, http).await?,
            "rpc" => rpc(addr, http).await?,
            s => bail!("unknown scenario {s}"),
        };
        println!("{out}");
        Ok(())
    })
}
