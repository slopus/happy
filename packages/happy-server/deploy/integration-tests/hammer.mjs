// Hammer harness for the multi-pod handy-server stack.
//
// Scenarios:
//   pod-kill-mid-rpc       Kill daemon's pod while caller has an in-flight RPC.
//   ttl-expiry             Stop refreshing TTL, wait > 60s, see if RPC keeps working.
//   reconnect-storm        Force-disconnect daemon repeatedly under load.
//   redis-blackout         Drop pod→Redis traffic mid-test (TODO).
//   cross-pod-broadcast    Subscribe on pod A, emit on pod B, measure fan-out.
//
// Run as:  node deploy/hammer.mjs <scenario>

import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync, spawnSync } from "child_process";

const SERVER = "http://127.0.0.1:3000";
const base64 = (b) => Buffer.from(b).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
    const kp = tweetnacl.sign.keyPair();
    const ch = tweetnacl.randomBytes(32);
    const sig = tweetnacl.sign.detached(ch, kp.secretKey);
    const r = await fetch(`${SERVER}/v1/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            publicKey: base64(kp.publicKey),
            challenge: base64(ch),
            signature: base64(sig),
        }),
    });
    if (!r.ok) throw new Error(`auth ${r.status}`);
    const j = await r.json();
    return j.token;
}

function kc(args) {
    return execSync(`kubectl ${args}`).toString().trim();
}

function getPods() {
    return kc("get pods -l app=handy-server -o jsonpath='{.items[*].metadata.name}'")
        .replace(/'/g, "")
        .split(/\s+/)
        .filter(Boolean);
}

function findPodFor(socketId) {
    for (const p of getPods()) {
        try {
            const out = execSync(`kubectl logs ${p} --tail=2000 2>/dev/null`).toString();
            if (out.includes(socketId)) return p;
        } catch {}
    }
    return "?";
}

async function connect(token, opts = {}) {
    const s = io(SERVER, {
        path: "/v1/updates",
        auth: { token, ...opts },
        transports: ["websocket"],
        reconnection: opts.reconnection ?? true,
        reconnectionDelay: 200,
        reconnectionDelayMax: 2000,
        reconnectionAttempts: opts.reconnectionAttempts ?? 100,
    });
    s.on("connect", () => log(`  socket ${s.id} connected`));
    s.on("disconnect", (reason) => log(`  socket ${s.id ?? "?"} disconnect: ${reason}`));
    s.on("connect_error", (e) => log(`  socket connect_error: ${e.message}`));
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("connect timeout")), 10_000);
        s.once("connect", () => { clearTimeout(t); res(s); });
        s.once("connect_error", (e) => { clearTimeout(t); rej(e); });
    });
}

const startTime = Date.now();
function log(msg) {
    const t = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[+${t.padStart(6)}s] ${msg}`);
}

// Retry rpc-register because the server's connection handler does an
// async auth.verifyToken before attaching the rpcHandler — messages
// emitted in that window can be dropped. Up to 5 attempts at 200ms.
async function awaitRegister(daemon, method) {
    for (let i = 0; i < 5; i++) {
        const acked = await new Promise((res) => {
            const t = setTimeout(() => res(false), 200);
            daemon.once("rpc-registered", () => { clearTimeout(t); res(true); });
            daemon.emit("rpc-register", { method });
        });
        if (acked) return;
    }
    throw new Error(`rpc-register failed after 5 attempts for ${method}`);
}

async function registerEcho(daemon, method) {
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    await awaitRegister(daemon, method);
}

async function rpcCall(caller, method, payload, timeout = 10_000) {
    const start = Date.now();
    try {
        const result = await caller.timeout(timeout).emitWithAck("rpc-call", { method, params: payload });
        return { ok: result.ok, error: result.error, latency: Date.now() - start, payload: result.result };
    } catch (e) {
        return { ok: false, error: e.message, latency: Date.now() - start };
    }
}

// === SCENARIO: pod-kill-mid-rpc ===
async function podKillMidRpc() {
    log("=== pod-kill-mid-rpc ===");
    const token = await getToken();
    const sessionId = `kill-${Date.now()}`;
    const METHOD = `${sessionId}:slow`;

    log("connecting daemon");
    const daemon = await connect(token, { clientType: "session-scoped", sessionId });

    daemon.on("rpc-request", async (data, cb) => {
        log(`  daemon got rpc-request, sleeping 5s`);
        await sleep(5_000);
        cb(data.params);
    });
    await awaitRegister(daemon, METHOD);
    log(`registered method ${METHOD}`);

    const daemonPod = findPodFor(daemon.id);
    log(`daemon pod = ${daemonPod}`);

    // Make sure caller lands on a different pod by trying many
    let caller, callerPod;
    for (let i = 0; i < 20; i++) {
        const c = await connect(token, { clientType: "user-scoped" });
        await sleep(200);
        const p = findPodFor(c.id);
        if (p !== daemonPod) {
            caller = c;
            callerPod = p;
            break;
        }
        c.disconnect();
    }
    if (!caller) {
        log("could not get cross-pod caller, using same-pod");
        caller = await connect(token, { clientType: "user-scoped" });
        callerPod = daemonPod;
    }
    log(`caller pod = ${callerPod} (cross-pod=${callerPod !== daemonPod})`);

    log("firing rpc-call (will block 5s in handler)");
    const callPromise = rpcCall(caller, METHOD, "alive?", 30_000);

    // Kill daemon's pod 1s into the call
    await sleep(1_000);
    log(`killing daemon pod ${daemonPod}`);
    try {
        kc(`delete pod ${daemonPod} --grace-period=0 --force --wait=false`);
    } catch (e) {
        log(`kill error: ${e.message}`);
    }

    const result = await callPromise;
    log(`rpc-call result: ok=${result.ok} latency=${result.latency}ms err=${result.error ?? "-"}`);

    daemon.disconnect();
    caller.disconnect();
    process.exit(0);
}

// === SCENARIO: reconnect-storm ===
async function reconnectStorm() {
    log("=== reconnect-storm ===");
    const token = await getToken();
    const sessionId = `storm-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, { clientType: "session-scoped", sessionId });
    await registerEcho(daemon, METHOD);
    log(`daemon registered`);

    const callers = [];
    for (let i = 0; i < 5; i++) {
        callers.push(await connect(token, { clientType: "user-scoped" }));
    }
    log(`${callers.length} callers connected`);
    await sleep(500);

    // Background: every 200ms each caller fires an RPC
    let success = 0, fail = 0;
    const errors = new Map();
    let stop = false;
    const callerLoops = callers.map(async (c, i) => {
        while (!stop) {
            const r = await rpcCall(c, METHOD, `c${i}-${Date.now()}`, 5_000);
            if (r.ok) success++;
            else { fail++; errors.set(r.error, (errors.get(r.error) || 0) + 1); }
            await sleep(200);
        }
    });

    // Force daemon to reconnect 5 times with 1s pauses
    for (let i = 0; i < 5; i++) {
        await sleep(2_000);
        log(`disconnecting daemon (round ${i + 1}/5)`);
        daemon.disconnect();
        await sleep(100);
        daemon.connect();
        await new Promise((r) => daemon.once("connect", r));
        await registerEcho(daemon, METHOD);
        log(`daemon re-registered after reconnect`);
    }

    await sleep(2_000);
    stop = true;
    await Promise.all(callerLoops);

    log(`results: success=${success} fail=${fail}`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);

    daemon.disconnect();
    callers.forEach(c => c.disconnect());
    process.exit(0);
}

// === SCENARIO: ttl-expiry ===
async function ttlExpiry() {
    log("=== ttl-expiry ===");
    log("daemon registers, then we wait 70s WITHOUT sending machine-alive");
    log("this should let the 60s Redis TTL expire");
    const token = await getToken();
    const sessionId = `ttl-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, { clientType: "session-scoped", sessionId });
    await registerEcho(daemon, METHOD);
    log("daemon registered, daemon stays connected, but we never send keep-alive");

    const caller = await connect(token, { clientType: "user-scoped" });

    for (const t of [5, 30, 55, 65, 75]) {
        await sleep((t - (t === 5 ? 0 : (t === 30 ? 5 : t === 55 ? 30 : t === 65 ? 55 : 65))) * 1_000);
        const r = await rpcCall(caller, METHOD, `t=${t}`, 5_000);
        log(`t=+${t}s rpc: ok=${r.ok} err=${r.error ?? "-"} latency=${r.latency}ms`);
    }

    daemon.disconnect();
    caller.disconnect();
    process.exit(0);
}

// === SCENARIO: brief-disconnect ===
// Daemon disconnects RIGHT BEFORE the caller fires its rpc-call. Daemon
// reconnects 1.5s later. With wait-for-reconnect grace, the call should
// succeed (single RPC, ~1.5s latency). Without grace, it would fail fast.
async function briefDisconnect() {
    log("=== brief-disconnect ===");
    const token = await getToken();
    const sessionId = `brief-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, { clientType: "session-scoped", sessionId });
    daemon.on("rpc-request", (data, cb) => cb({ echo: data.params }));
    await awaitRegister(daemon, METHOD);
    log("daemon registered");

    const caller = await connect(token, { clientType: "user-scoped" });
    log("caller connected");

    // Disconnect daemon immediately
    log("disconnecting daemon");
    daemon.disconnect();

    // Schedule reconnect in 1.5s — also re-register
    setTimeout(async () => {
        log("daemon RECONNECTING");
        daemon.connect();
        await new Promise((r) => daemon.once("connect", r));
        log("daemon reconnected, re-registering");
        await awaitRegister(daemon, METHOD);
    }, 1500);

    // Fire rpc-call immediately. Should wait, then succeed.
    log("firing rpc-call (daemon offline, will reconnect in 1.5s)");
    const t0 = Date.now();
    const r = await rpcCall(caller, METHOD, "hello", 10_000);
    log(`rpc-call: ok=${r.ok} latency=${Date.now() - t0}ms result=${JSON.stringify(r.payload ?? r.error)}`);

    // Also test that subsequent calls work after reconnect
    await sleep(500);
    const r2 = await rpcCall(caller, METHOD, "hello2", 5_000);
    log(`follow-up rpc-call: ok=${r2.ok} latency=${r2.latency}ms`);

    daemon.disconnect();
    caller.disconnect();
    process.exit(0);
}

// === SCENARIO: long-disconnect ===
// Daemon disconnects and never comes back. The wait-for-reconnect grace must
// expire and the call must fail with "RPC method not available" promptly
// (within ~grace + small fudge), not hang for 30s.
async function longDisconnect() {
    log("=== long-disconnect ===");
    const token = await getToken();
    const sessionId = `long-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, { clientType: "session-scoped", sessionId });
    daemon.on("rpc-request", (data, cb) => cb({ echo: data.params }));
    await awaitRegister(daemon, METHOD);
    log("daemon registered");

    const caller = await connect(token, { clientType: "user-scoped" });

    log("disconnecting daemon FOREVER");
    daemon.disconnect();

    log("firing rpc-call (daemon will not reconnect)");
    const t0 = Date.now();
    const r = await rpcCall(caller, METHOD, "ghost", 30_000);
    log(`rpc-call: ok=${r.ok} latency=${Date.now() - t0}ms err=${r.error ?? "-"}`);

    caller.disconnect();
    process.exit(0);
}

// === main ===
const scenario = process.argv[2];
const scenarios = {
    "pod-kill-mid-rpc": podKillMidRpc,
    "reconnect-storm": reconnectStorm,
    "ttl-expiry": ttlExpiry,
    "brief-disconnect": briefDisconnect,
    "long-disconnect": longDisconnect,
};
if (!scenario || !scenarios[scenario]) {
    console.error(`usage: node deploy/hammer.mjs <${Object.keys(scenarios).join("|")}>`);
    process.exit(2);
}
scenarios[scenario]().catch((e) => { console.error(e); process.exit(1); });
