// Stress test: sync degradation and recovery after disruptions
//
// Reproduces the "sucky period" where the system enters a degraded state
// after server disruptions and fails to self-heal.
//
// Scenarios:
//   full-server-outage     Kill ALL pods, verify daemon recovers when server returns.
//   reconnect-connect-err  Daemon's reconnect hits connect_error, verify it retries.
//   sync-after-gap         Messages sent during disconnect, verify sync catches up.
//   rpc-after-reconnect    Daemon reconnects, verify RPC works immediately (no stale state).
//   cascading-disruption   Multiple rapid disruptions, verify eventual recovery.
//
// Run as:  node deploy/integration-tests/stress-sync-degradation.mjs <scenario|all>

import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync } from "child_process";

const SERVER = "http://127.0.0.1:3000";
const base64 = (b) => Buffer.from(b).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startTime = Date.now();
function log(msg) {
    const t = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[+${t.padStart(7)}s] ${msg}`);
}

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
    return (await r.json()).token;
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

async function connect(token, opts = {}) {
    const s = io(SERVER, {
        path: "/v1/updates",
        auth: { token, ...opts },
        transports: ["websocket"],
        reconnection: opts.reconnection ?? false,
        reconnectionDelay: opts.reconnectionDelay ?? 1000,
        reconnectionDelayMax: opts.reconnectionDelayMax ?? 5000,
        reconnectionAttempts: opts.reconnectionAttempts ?? 100,
    });
    s.on("connect_error", (e) => log(`  connect_error: ${e.message}`));
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("connect timeout")), 15_000);
        s.once("connect", () => { clearTimeout(t); res(s); });
        s.once("connect_error", (e) => { clearTimeout(t); rej(e); });
    });
}

async function awaitRegister(daemon, method) {
    for (let i = 0; i < 5; i++) {
        const acked = await new Promise((res) => {
            const t = setTimeout(() => res(false), 300);
            daemon.once("rpc-registered", () => { clearTimeout(t); res(true); });
            daemon.emit("rpc-register", { method });
        });
        if (acked) return true;
    }
    return false;
}

async function rpcCall(caller, method, payload, timeout = 10_000) {
    const start = Date.now();
    try {
        const result = await caller.timeout(timeout).emitWithAck("rpc-call", { method, params: payload });
        return { ok: result.ok, error: result.error, latency: Date.now() - start };
    } catch (e) {
        return { ok: false, error: e.message, latency: Date.now() - start };
    }
}


// === SCENARIO: full-server-outage ===
// Kill ALL server pods. Daemon socket disconnects. Wait for new pods.
// Verify the daemon socket reconnects and RPC works again.
// This simulates the worst-case deploy scenario.
async function fullServerOutage() {
    log("=== full-server-outage ===");
    log("Kill ALL pods, wait for replacements, verify daemon recovers");

    const token = await getToken();
    const sessionId = `outage-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    // Daemon with auto-reconnect enabled (simulates real daemon behavior)
    const daemon = await connect(token, {
        clientType: "session-scoped",
        sessionId,
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 200,
    });
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    await awaitRegister(daemon, METHOD);

    // Verify pre-outage
    const caller = await connect(token, { clientType: "user-scoped" });
    const pre = await rpcCall(caller, METHOD, "pre-outage", 5_000);
    log(`pre-outage RPC: ok=${pre.ok}`);
    caller.disconnect();

    // Track events
    let disconnects = 0, reconnects = 0, connectErrors = 0;
    daemon.on("disconnect", () => { disconnects++; });
    daemon.on("connect", () => {
        reconnects++;
        daemon.emit("rpc-register", { method: METHOD });
        log(`daemon reconnected (#${reconnects}), re-registered`);
    });
    daemon.io.on("reconnect_error", () => { connectErrors++; });

    // Kill ALL pods at once
    const pods = getPods();
    log(`killing ALL ${pods.length} pods simultaneously`);
    for (const pod of pods) {
        try { kc(`delete pod ${pod} --grace-period=0 --force --wait=false`); } catch {}
    }

    // Wait for new pods to come up
    log("waiting for replacement pods...");
    for (let i = 0; i < 60; i++) {
        await sleep(2000);
        try {
            const readyPods = kc("get pods -l app=handy-server --field-selector=status.phase=Running -o name")
                .split("\n").filter(Boolean).length;
            if (readyPods >= 2) {
                log(`${readyPods} pods ready after ${(i + 1) * 2}s`);
                break;
            }
        } catch {}
    }
    await sleep(3000);

    log(`daemon stats: disconnects=${disconnects} reconnects=${reconnects} connectErrors=${connectErrors}`);

    // Try RPC after recovery
    let postOutageSuccess = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
        try {
            const postCaller = await connect(token, { clientType: "user-scoped" });
            const r = await rpcCall(postCaller, METHOD, `post-outage-${attempt}`, 5_000);
            postCaller.disconnect();
            log(`attempt ${attempt}: rpc ok=${r.ok} err=${r.error ?? "-"}`);
            if (r.ok) {
                postOutageSuccess = true;
                break;
            }
        } catch (e) {
            log(`attempt ${attempt}: caller connect failed: ${e.message}`);
        }
        await sleep(2000);
    }

    daemon.disconnect();

    log(postOutageSuccess
        ? `✅ PASSED — daemon recovered after full server outage`
        : `❌ FAILED — daemon never recovered (reconnects=${reconnects}, connectErrors=${connectErrors})`
    );
    return postOutageSuccess;
}


// === SCENARIO: reconnect-connect-err ===
// Simulates the real client's startSmartReconnect behavior:
// reconnection: false, manual connect() call. If connect() fails,
// does the client retry or get stuck?
async function reconnectConnectErr() {
    log("=== reconnect-connect-err ===");
    log("Manual reconnect (like real client): what happens when connect() hits connect_error?");

    const token = await getToken();
    const sessionId = `rce-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    // Manual reconnect mode (like real apiSession/apiMachine client)
    const daemon = io(SERVER, {
        path: "/v1/updates",
        auth: { token, clientType: "session-scoped", sessionId },
        transports: ["websocket"],
        reconnection: false, // Real client behavior
    });

    daemon.on("rpc-request", (data, cb) => cb(data.params));

    let connectCount = 0, disconnectCount = 0, connectErrorCount = 0;

    daemon.on("connect", () => {
        connectCount++;
        daemon.emit("rpc-register", { method: METHOD });
        log(`daemon connected (#${connectCount})`);
    });
    daemon.on("disconnect", (reason) => {
        disconnectCount++;
        log(`daemon disconnected (#${disconnectCount}): ${reason}`);
    });
    daemon.on("connect_error", (e) => {
        connectErrorCount++;
        log(`daemon connect_error (#${connectErrorCount}): ${e.message}`);
    });

    // Wait for initial connect
    await new Promise((r) => daemon.once("connect", r));

    // Verify pre-disruption
    const caller = await connect(token, { clientType: "user-scoped" });
    const pre = await rpcCall(caller, METHOD, "pre", 5_000);
    log(`pre-disruption RPC: ok=${pre.ok}`);
    caller.disconnect();

    // Kill all pods
    const pods = getPods();
    log(`killing ALL ${pods.length} pods`);
    for (const pod of pods) {
        try { kc(`delete pod ${pod} --grace-period=0 --force --wait=false`); } catch {}
    }

    // Wait for disconnect
    await sleep(3000);

    // Now simulate the real client's startSmartReconnect:
    // ONE attempt, then nothing if it fails
    log("attempting manual reconnect (one-shot, like real client)...");
    daemon.connect();

    // Wait for the attempt to resolve
    await sleep(5000);
    log(`after one-shot: connected=${daemon.connected} connectErrors=${connectErrorCount}`);

    // Now wait for server to come back
    log("waiting for server to recover...");
    for (let i = 0; i < 60; i++) {
        await sleep(2000);
        try {
            const health = await fetch(`${SERVER}/health`).then(r => r.json());
            if (health.status === "ok") {
                log(`server healthy after ${(i + 1) * 2}s`);
                break;
            }
        } catch {}
    }
    await sleep(2000);

    // Is the daemon STILL disconnected? (The bug)
    log(`daemon connected after server recovery: ${daemon.connected}`);

    if (!daemon.connected) {
        log("attempting second manual reconnect...");
        daemon.connect();
        await new Promise((resolve) => {
            const t = setTimeout(() => resolve(), 10_000);
            daemon.once("connect", () => { clearTimeout(t); resolve(); });
        });
        log(`daemon connected after second attempt: ${daemon.connected}`);
    }

    // Try RPC
    let rpcWorks = false;
    if (daemon.connected) {
        try {
            const postCaller = await connect(token, { clientType: "user-scoped" });
            const r = await rpcCall(postCaller, METHOD, "post", 5_000);
            postCaller.disconnect();
            rpcWorks = r.ok;
            log(`post-recovery RPC: ok=${r.ok}`);
        } catch (e) {
            log(`post-recovery caller failed: ${e.message}`);
        }
    }

    daemon.disconnect();

    const stuckAfterOneShot = !daemon.connected || !rpcWorks;
    log(stuckAfterOneShot
        ? "❌ BUG CONFIRMED — one-shot reconnect fails, daemon stays disconnected"
        : "✅ PASSED"
    );
    return !stuckAfterOneShot;
}


// === SCENARIO: rpc-after-reconnect ===
// Daemon reconnects (auto-reconnect enabled), re-registers fire-and-forget.
// Verify RPC works IMMEDIATELY after reconnect, not after a delay.
async function rpcAfterReconnect() {
    log("=== rpc-after-reconnect ===");
    log("Daemon reconnects with auto-reconnect, verify RPC works immediately");

    const token = await getToken();
    const sessionId = `rar-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, {
        clientType: "session-scoped",
        sessionId,
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: 50,
    });
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    await awaitRegister(daemon, METHOD);

    const caller = await connect(token, {
        clientType: "user-scoped",
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: 50,
    });

    // Verify pre-disruption
    const pre = await rpcCall(caller, METHOD, "pre", 5_000);
    log(`pre-disruption RPC: ok=${pre.ok}`);

    // Re-register on reconnect (fire-and-forget, like real client)
    daemon.on("connect", () => {
        daemon.emit("rpc-register", { method: METHOD });
    });

    // Kill ONE pod (daemon should reconnect to surviving pod)
    const pods = getPods();
    log(`killing pod ${pods[0]}`);
    try { kc(`delete pod ${pods[0]} --grace-period=0 --force --wait=false`); } catch {}

    // Wait for reconnection
    await sleep(5000);
    log(`daemon connected: ${daemon.connected}, caller connected: ${caller.connected}`);

    // Try RPC immediately — this should work
    const TRIALS = 10;
    let success = 0, fail = 0;
    const errors = new Map();

    for (let i = 0; i < TRIALS; i++) {
        const r = await rpcCall(caller, METHOD, `trial-${i}`, 5_000);
        if (r.ok) success++;
        else {
            fail++;
            errors.set(r.error, (errors.get(r.error) || 0) + 1);
        }
    }

    log(`\nResults: ${success}/${TRIALS} success, ${fail}/${TRIALS} fail`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);

    daemon.disconnect();
    caller.disconnect();

    // Wait for replacement pod
    try { kc("wait --for=condition=ready pod -l app=handy-server --timeout=120s"); } catch {}

    log(fail === 0 ? "✅ PASSED" : "❌ FAILURES — RPC broken after reconnect");
    return fail === 0;
}


// === SCENARIO: cascading-disruption ===
// Multiple rapid disruptions: kill a pod every 10s while continuous RPC traffic flows.
// Simulates a deployment that takes a while or a flapping server.
async function cascadingDisruption() {
    log("=== cascading-disruption ===");
    log("Kill a pod every 10s for 30s, continuous RPC traffic — simulates flapping server");

    const token = await getToken();
    const sessionId = `cascade-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, {
        clientType: "session-scoped",
        sessionId,
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: 200,
    });
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    await awaitRegister(daemon, METHOD);
    daemon.on("connect", () => {
        daemon.emit("rpc-register", { method: METHOD });
    });

    const caller = await connect(token, {
        clientType: "user-scoped",
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: 200,
    });

    // Verify baseline
    const pre = await rpcCall(caller, METHOD, "pre", 5_000);
    log(`baseline RPC: ok=${pre.ok}`);

    // Background: continuous RPC traffic
    let success = 0, fail = 0, total = 0;
    const errors = new Map();
    let stop = false;

    const trafficLoop = (async () => {
        while (!stop) {
            total++;
            const r = await rpcCall(caller, METHOD, `t-${total}`, 5_000);
            if (r.ok) success++;
            else {
                fail++;
                errors.set(r.error, (errors.get(r.error) || 0) + 1);
            }
            await sleep(500);
        }
    })();

    // Kill pods at intervals
    for (let wave = 0; wave < 3; wave++) {
        await sleep(10_000);
        const pods = getPods();
        if (pods.length > 0) {
            const target = pods[Math.floor(Math.random() * pods.length)];
            log(`wave ${wave + 1}/3: killing pod ${target} (${pods.length} pods)`);
            try { kc(`delete pod ${target} --grace-period=1 --wait=false`); } catch {}
        }
    }

    // Let traffic continue for 10 more seconds after last kill
    await sleep(10_000);

    // Final check: are the last N calls succeeding?
    const finalSuccess = [];
    for (let i = 0; i < 5; i++) {
        const r = await rpcCall(caller, METHOD, `final-${i}`, 5_000);
        finalSuccess.push(r.ok);
        await sleep(500);
    }
    stop = true;
    await trafficLoop;

    const finalRate = finalSuccess.filter(Boolean).length / finalSuccess.length;

    log(`\nOverall: ${success}/${total} success, ${fail}/${total} fail`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);
    log(`Final 5 calls: ${finalSuccess.filter(Boolean).length}/5 success`);

    daemon.disconnect();
    caller.disconnect();

    // Wait for cluster to stabilize
    try { kc("wait --for=condition=ready pod -l app=handy-server --timeout=120s"); } catch {}

    const overallRate = success / total;
    log(`Overall success rate: ${(overallRate * 100).toFixed(1)}%`);
    log(`Final success rate: ${(finalRate * 100).toFixed(1)}%`);

    const pass = finalRate >= 0.8;
    log(pass
        ? "✅ PASSED — system recovered (final calls working)"
        : "❌ FAILED — system entered degraded state and did not recover"
    );
    return pass;
}


// === main ===
const scenarios = {
    "full-server-outage": fullServerOutage,
    "reconnect-connect-err": reconnectConnectErr,
    "rpc-after-reconnect": rpcAfterReconnect,
    "cascading-disruption": cascadingDisruption,
};

const arg = process.argv[2];

if (arg === "all") {
    let passed = 0, failed = 0;
    for (const [name, fn] of Object.entries(scenarios)) {
        try {
            const ok = await fn();
            if (ok) passed++;
            else failed++;
        } catch (e) {
            log(`${name} CRASHED: ${e.message}`);
            failed++;
        }
        log("");
    }
    log("========================================");
    log(`  SUMMARY: ${passed} passed, ${failed} failed`);
    log("========================================");
    process.exit(failed > 0 ? 1 : 0);
} else if (arg && scenarios[arg]) {
    scenarios[arg]().then(ok => process.exit(ok ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
} else {
    console.error(`usage: node deploy/integration-tests/stress-sync-degradation.mjs <${Object.keys(scenarios).join("|")}|all>`);
    process.exit(2);
}
