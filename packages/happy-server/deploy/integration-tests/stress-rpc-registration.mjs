// Stress test: RPC registration reliability
//
// These scenarios reproduce issue #1074 by simulating the REAL client behavior:
// the daemon emits rpc-register once on connect without waiting for ack,
// exactly like RpcHandlerManager.onSocketConnect() does. The server's async
// auth.verifyToken() may not have set up the rpc-register listener yet,
// causing silent event drops and "RPC method not available" for callers.
//
// Scenarios:
//   fire-and-forget       Daemon registers once (no ack wait), caller tries immediately.
//   register-race-timing  Daemon registers once, callers try at 0/100/500/1000/2000ms.
//   reconnect-no-ack      Daemon reconnects 5x, re-registers once each time (no ack wait).
//   rapid-sessions        10 daemons connect + register in parallel (no ack wait).
//   rolling-deploy        Kill one pod, verify daemon RPCs still work after re-scheduling.
//   stale-room-cleanup    Kill daemon's pod, verify room gets cleaned up cross-replica.
//   ios-session-flow      Exact iOS flow: machine RPC → spawn session → session RPC.
//   high-concurrency      50 daemons connect + register simultaneously, callers blast RPCs.
//   cross-replica-3pod    3-replica test: daemon on pod A, caller on pod C, verify routing.
//
// Run as:  node deploy/integration-tests/stress-rpc-registration.mjs <scenario|all>

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
        reconnection: opts.reconnection ?? false,
        reconnectionDelay: 200,
        reconnectionDelayMax: 2000,
        reconnectionAttempts: opts.reconnectionAttempts ?? 20,
    });
    s.on("connect_error", (e) => log(`  connect_error: ${e.message}`));
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("connect timeout")), 10_000);
        s.once("connect", () => { clearTimeout(t); res(s); });
        s.once("connect_error", (e) => { clearTimeout(t); rej(e); });
    });
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

// === Retry-based register (like hammer.mjs — for comparison) ===
async function awaitRegister(daemon, method) {
    for (let i = 0; i < 5; i++) {
        const acked = await new Promise((res) => {
            const t = setTimeout(() => res(false), 200);
            daemon.once("rpc-registered", () => { clearTimeout(t); res(true); });
            daemon.emit("rpc-register", { method });
        });
        if (acked) return true;
    }
    return false;
}

// === SCENARIO: fire-and-forget ===
// Simulates the real RpcHandlerManager.onSocketConnect() behavior:
// emit rpc-register once, no ack wait, caller fires immediately.
async function fireAndForget() {
    log("=== fire-and-forget ===");
    log("Simulates real client: register once, no ack, caller fires immediately");

    const ROUNDS = 20;
    let success = 0, fail = 0;
    const errors = new Map();

    for (let round = 0; round < ROUNDS; round++) {
        const token = await getToken();
        const sessionId = `faf-${Date.now()}-${round}`;
        const METHOD = `${sessionId}:echo`;

        const daemon = await connect(token, { clientType: "session-scoped", sessionId });
        daemon.on("rpc-request", (data, cb) => cb(data.params));

        // Fire-and-forget register — exactly like the real client
        daemon.emit("rpc-register", { method: METHOD });
        // NO await, NO ack wait

        const caller = await connect(token, { clientType: "user-scoped" });

        // Try RPC immediately (within ~50ms of daemon connect)
        const r = await rpcCall(caller, METHOD, `round-${round}`, 12_000);
        if (r.ok) success++;
        else {
            fail++;
            errors.set(r.error, (errors.get(r.error) || 0) + 1);
        }

        daemon.disconnect();
        caller.disconnect();
    }

    log(`\nResults: ${success}/${ROUNDS} success, ${fail}/${ROUNDS} fail`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);
    log(fail === 0 ? "✅ PASSED" : "❌ FAILURES — registration race confirmed");
    return fail === 0;
}


// === SCENARIO: register-race-timing ===
// Daemon registers once (fire-and-forget), callers try at different delays.
// Reveals the window during which "RPC method not available" occurs.
async function registerRaceTiming() {
    log("=== register-race-timing ===");
    log("Daemon registers once (no ack), callers try at 0/50/100/200/500/1000/2000ms");

    const delays = [0, 50, 100, 200, 500, 1000, 2000];
    const TRIALS = 10;
    const results = {};

    for (const delayMs of delays) {
        results[delayMs] = { success: 0, fail: 0, errors: [] };
    }

    for (let trial = 0; trial < TRIALS; trial++) {
        const token = await getToken();
        const sessionId = `race-${Date.now()}-${trial}`;
        const METHOD = `${sessionId}:echo`;

        const daemon = await connect(token, { clientType: "session-scoped", sessionId });
        daemon.on("rpc-request", (data, cb) => cb(data.params));
        daemon.emit("rpc-register", { method: METHOD });

        // Fire callers at each delay
        const callPromises = delays.map(async (delayMs) => {
            const caller = await connect(token, { clientType: "user-scoped" });
            await sleep(delayMs);
            const r = await rpcCall(caller, METHOD, `delay-${delayMs}`, 12_000);
            caller.disconnect();
            return { delayMs, ...r };
        });

        const callResults = await Promise.all(callPromises);
        for (const r of callResults) {
            if (r.ok) results[r.delayMs].success++;
            else {
                results[r.delayMs].fail++;
                results[r.delayMs].errors.push(r.error);
            }
        }

        daemon.disconnect();
    }

    log("\nTiming results:");
    log("  delay    success   fail   errors");
    for (const delayMs of delays) {
        const r = results[delayMs];
        const errs = [...new Set(r.errors)].join(", ") || "-";
        log(`  ${String(delayMs).padStart(5)}ms   ${String(r.success).padStart(4)}/${TRIALS}   ${String(r.fail).padStart(3)}    ${errs}`);
    }

    const totalFail = Object.values(results).reduce((s, r) => s + r.fail, 0);
    log(totalFail === 0 ? "\n✅ PASSED" : "\n❌ FAILURES — race window detected");
    return totalFail === 0;
}


// === SCENARIO: reconnect-no-ack ===
// Daemon reconnects 5x, re-registers once each time without ack (real client behavior).
// Callers fire RPCs continuously. Compare with hammer.mjs reconnect-storm (which uses awaitRegister).
async function reconnectNoAck() {
    log("=== reconnect-no-ack ===");
    log("Daemon reconnects 5x, re-registers once (no ack) each time — simulates real client");

    const token = await getToken();
    const sessionId = `rna-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, { clientType: "session-scoped", sessionId, reconnection: false });
    daemon.on("rpc-request", (data, cb) => cb(data.params));

    // First register with retry to get a clean baseline
    await awaitRegister(daemon, METHOD);
    log("daemon registered (initial — with ack)");

    const callers = [];
    for (let i = 0; i < 5; i++) {
        callers.push(await connect(token, { clientType: "user-scoped" }));
    }
    log(`${callers.length} callers connected`);
    await sleep(500);

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

    for (let i = 0; i < 5; i++) {
        await sleep(2_000);
        log(`disconnecting daemon (round ${i + 1}/5)`);
        daemon.disconnect();
        await sleep(100);
        daemon.connect();
        await new Promise((r) => daemon.once("connect", r));
        // Re-register once, NO ack wait — simulates real client
        daemon.emit("rpc-register", { method: METHOD });
        log(`daemon re-registered (fire-and-forget) after reconnect`);
    }

    await sleep(2_000);
    stop = true;
    await Promise.all(callerLoops);

    log(`\nResults: success=${success} fail=${fail}`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);

    // Compare expected: hammer.mjs reconnect-storm (with awaitRegister) got ~3% failure
    // Without ack, we expect significantly higher failure rate
    const failRate = fail / (success + fail);
    log(`Failure rate: ${(failRate * 100).toFixed(1)}%`);
    log(fail === 0 ? "✅ PASSED" : "❌ FAILURES — no-ack registration is unreliable");

    daemon.disconnect();
    callers.forEach(c => c.disconnect());
    return fail === 0;
}


// === SCENARIO: rapid-sessions ===
// 10 daemons connect + register in parallel (fire-and-forget), simulating
// 10 rapid session creates from iOS/mobile. A user-scoped caller then
// tries to call each daemon's method. This directly models issue #1074.
async function rapidSessions() {
    log("=== rapid-sessions ===");
    log("10 daemons connect + register (no ack) in parallel — simulates iOS rapid session create");

    const NUM_DAEMONS = 10;
    const token = await getToken();

    // Launch all daemons in parallel
    const daemonPromises = [];
    for (let i = 0; i < NUM_DAEMONS; i++) {
        const sessionId = `rapid-${Date.now()}-${i}`;
        const method = `${sessionId}:echo`;
        daemonPromises.push(
            connect(token, { clientType: "session-scoped", sessionId }).then(daemon => {
                daemon.on("rpc-request", (data, cb) => cb(data.params));
                daemon.emit("rpc-register", { method });
                return { daemon, method, sessionId };
            })
        );
    }

    const daemons = await Promise.all(daemonPromises);
    log(`${NUM_DAEMONS} daemons connected + registered (fire-and-forget)`);

    // Caller connects and tries each daemon's method immediately
    const caller = await connect(token, { clientType: "user-scoped" });
    log("caller connected, firing RPCs to all daemons");

    let success = 0, fail = 0;
    const errors = new Map();

    // Try each daemon with no delay — immediate burst
    const results = await Promise.all(
        daemons.map(async ({ method }, i) => {
            const r = await rpcCall(caller, method, `session-${i}`, 12_000);
            return { method, ...r };
        })
    );

    for (const r of results) {
        if (r.ok) success++;
        else {
            fail++;
            errors.set(r.error, (errors.get(r.error) || 0) + 1);
        }
    }

    log(`\nImmediate results: ${success}/${NUM_DAEMONS} success, ${fail}/${NUM_DAEMONS} fail`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);

    // Now retry after 2s — are they eventually registered?
    await sleep(2000);
    let retrySuccess = 0, retryFail = 0;
    const retryErrors = new Map();

    const retryResults = await Promise.all(
        daemons.map(async ({ method }, i) => {
            const r = await rpcCall(caller, method, `retry-${i}`, 5_000);
            return { method, ...r };
        })
    );

    for (const r of retryResults) {
        if (r.ok) retrySuccess++;
        else {
            retryFail++;
            retryErrors.set(r.error, (retryErrors.get(r.error) || 0) + 1);
        }
    }

    log(`After 2s retry: ${retrySuccess}/${NUM_DAEMONS} success, ${retryFail}/${NUM_DAEMONS} fail`);
    for (const [err, n] of retryErrors) log(`  err: ${err} ×${n}`);

    caller.disconnect();
    daemons.forEach(d => d.daemon.disconnect());

    const passed = fail === 0;
    log(passed
        ? "✅ PASSED — all daemons reachable immediately"
        : retryFail > 0
            ? "❌ CRITICAL — daemons unreachable even after 2s (permanent registration loss)"
            : "⚠️  RACE CONFIRMED — daemons unreachable immediately, but self-heal after delay"
    );
    return passed;
}


// === SCENARIO: rolling-deploy ===
// Kill one pod, wait for replacement pod, verify daemon RPCs survive.
async function rollingDeploy() {
    log("=== rolling-deploy ===");
    log("Kill one pod, verify daemons on that pod recover RPC after rescheduling");

    const token = await getToken();
    const pods = getPods();
    log(`Pods: ${pods.join(", ")}`);

    // Connect daemon and register with ack (clean start)
    const sessionId = `roll-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;
    const daemon = await connect(token, { clientType: "session-scoped", sessionId, reconnection: true, reconnectionAttempts: 50 });
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    await awaitRegister(daemon, METHOD);

    const daemonPod = findPodFor(daemon.id);
    log(`daemon on pod ${daemonPod}`);

    // Verify RPC works pre-kill
    const caller = await connect(token, { clientType: "user-scoped", reconnection: true, reconnectionAttempts: 50 });
    const pre = await rpcCall(caller, METHOD, "pre-kill", 5_000);
    log(`pre-kill RPC: ok=${pre.ok}`);

    // Track daemon reconnect
    let daemonReconnected = false;
    daemon.on("connect", () => {
        daemonReconnected = true;
        // Re-register with fire-and-forget (real client behavior)
        daemon.emit("rpc-register", { method: METHOD });
        log("daemon reconnected and re-registered (fire-and-forget)");
    });

    // Kill daemon's pod
    log(`killing pod ${daemonPod}`);
    try { kc(`delete pod ${daemonPod} --grace-period=0 --force --wait=false`); } catch {}

    // Poll RPC until it works again (up to 60s)
    let postKillSuccess = false;
    for (let sec = 1; sec <= 60; sec++) {
        await sleep(1000);
        const r = await rpcCall(caller, METHOD, `post-kill-${sec}`, 3_000);
        log(`t+${String(sec).padStart(2)}s: rpc ok=${r.ok} reconnected=${daemonReconnected} err=${r.error ?? "-"}`);
        if (r.ok) {
            postKillSuccess = true;
            log(`RPC recovered after ${sec}s`);
            break;
        }
    }

    daemon.disconnect();
    caller.disconnect();

    // Wait for replacement pod
    log("waiting for replacement pod...");
    try { kc("wait --for=condition=ready pod -l app=handy-server --timeout=120s"); } catch {}

    log(postKillSuccess ? "✅ PASSED — RPC recovered after pod kill" : "❌ FAILED — RPC never recovered");
    return postKillSuccess;
}


// === SCENARIO: stale-room-cleanup ===
// Daemon registers on pod A, pod A is killed. Verify the room is cleaned up
// on pod B so that callers don't get stuck waiting for a dead socket.
async function staleRoomCleanup() {
    log("=== stale-room-cleanup ===");
    log("Kill daemon's pod, verify room is cleaned up cross-replica (fast fail, not 30s hang)");

    const token = await getToken();
    const pods = getPods();
    log(`Pods: ${pods.join(", ")}`);

    const sessionId = `stale-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, { clientType: "session-scoped", sessionId, reconnection: false });
    daemon.on("rpc-request", async (data, cb) => {
        await sleep(5000);
        cb(data.params);
    });
    await awaitRegister(daemon, METHOD);

    const daemonPod = findPodFor(daemon.id);
    log(`daemon on pod ${daemonPod}`);

    // Get a caller on a DIFFERENT pod
    let caller, callerPod;
    for (let i = 0; i < 20; i++) {
        const c = await connect(token, { clientType: "user-scoped" });
        await sleep(200);
        const p = findPodFor(c.id);
        if (p !== daemonPod) {
            caller = c; callerPod = p; break;
        }
        c.disconnect();
    }
    if (!caller) {
        caller = await connect(token, { clientType: "user-scoped" });
        callerPod = daemonPod;
        log("could not get cross-pod caller, using same-pod");
    }
    log(`caller on pod ${callerPod} (cross-pod=${callerPod !== daemonPod})`);

    // Kill daemon's pod (daemon has reconnection: false, so it won't come back)
    log(`killing pod ${daemonPod}`);
    try { kc(`delete pod ${daemonPod} --grace-period=0 --force --wait=false`); } catch {}
    await sleep(1000);

    // Fire RPC — should fail with "method not available" within the grace window (~10s),
    // NOT hang for 30s
    log("firing RPC to dead daemon (should fail within ~10s, not 30s)");
    const t0 = Date.now();
    const r = await rpcCall(caller, METHOD, "ghost", 35_000);
    const elapsed = Date.now() - t0;
    log(`rpc-call: ok=${r.ok} latency=${elapsed}ms err=${r.error ?? "-"}`);

    caller.disconnect();

    // Wait for replacement pod
    try { kc("wait --for=condition=ready pod -l app=handy-server --timeout=120s"); } catch {}

    const pass = !r.ok && elapsed < 15_000;
    log(pass
        ? `✅ PASSED — fast-fail in ${elapsed}ms (within grace window)`
        : elapsed >= 15_000
            ? `❌ FAILED — took ${elapsed}ms (should be <15s, room not cleaned up cross-replica)`
            : `⚠️  unexpected: ok=${r.ok} in ${elapsed}ms`
    );
    return pass;
}


// === SCENARIO: ios-session-flow ===
// Exact simulation of the iOS → server → daemon flow:
// 1. Machine daemon connects + registers spawn-happy-session (fire-and-forget)
// 2. "iOS" caller immediately calls spawn-happy-session via RPC
// 3. "Daemon" responds by connecting a session-scoped socket
// 4. Session socket registers session RPC methods (fire-and-forget)
// 5. "iOS" caller immediately calls session RPC method
async function iosSessionFlow() {
    log("=== ios-session-flow ===");
    log("Simulates: iOS creates session → machine RPC → daemon spawns session → session RPC");

    const ROUNDS = 15;
    let machineRpcSuccess = 0, machineRpcFail = 0;
    let sessionRpcSuccess = 0, sessionRpcFail = 0;
    const machineErrors = new Map();
    const sessionErrors = new Map();

    for (let round = 0; round < ROUNDS; round++) {
        const token = await getToken();
        const machineId = `machine-${Date.now()}-${round}`;
        const sessionId = `session-${Date.now()}-${round}`;
        const MACHINE_METHOD = `${machineId}:spawn-happy-session`;
        const SESSION_METHOD = `${sessionId}:bash`;

        // Step 1: Machine daemon connects and registers (fire-and-forget)
        const machineDaemon = await connect(token, {
            clientType: "machine-scoped",
            machineId,
        });
        machineDaemon.on("rpc-request", async (data, cb) => {
            // Simulate spawn: create session-scoped socket
            const sessionSocket = await connect(token, {
                clientType: "session-scoped",
                sessionId,
            });
            sessionSocket.on("rpc-request", (data, cb) => cb({ result: "bash-output" }));
            // Fire-and-forget session registration (real client behavior)
            sessionSocket.emit("rpc-register", { method: SESSION_METHOD });
            cb({ type: "success", sessionId });

            // Clean up after test
            setTimeout(() => sessionSocket.disconnect(), 15000);
        });
        machineDaemon.emit("rpc-register", { method: MACHINE_METHOD });

        // Step 2: "iOS" caller connects
        const iosCaller = await connect(token, { clientType: "user-scoped" });

        // Step 3: iOS calls machine RPC immediately (spawn session)
        const spawnResult = await rpcCall(iosCaller, MACHINE_METHOD, { directory: "/tmp" }, 12_000);
        if (spawnResult.ok) {
            machineRpcSuccess++;

            // Step 4: iOS immediately calls session RPC (bash)
            // Small delay to simulate real client round-trip
            await sleep(50);
            const bashResult = await rpcCall(iosCaller, SESSION_METHOD, { command: "echo test" }, 12_000);
            if (bashResult.ok) sessionRpcSuccess++;
            else {
                sessionRpcFail++;
                sessionErrors.set(bashResult.error, (sessionErrors.get(bashResult.error) || 0) + 1);
            }
        } else {
            machineRpcFail++;
            machineErrors.set(spawnResult.error, (machineErrors.get(spawnResult.error) || 0) + 1);
        }

        machineDaemon.disconnect();
        iosCaller.disconnect();
    }

    log(`\nMachine RPC (spawn): ${machineRpcSuccess}/${ROUNDS} success, ${machineRpcFail}/${ROUNDS} fail`);
    for (const [err, n] of machineErrors) log(`  err: ${err} ×${n}`);
    log(`Session RPC (bash):  ${sessionRpcSuccess}/${ROUNDS} success, ${sessionRpcFail}/${ROUNDS} fail`);
    for (const [err, n] of sessionErrors) log(`  err: ${err} ×${n}`);

    const allPass = machineRpcFail === 0 && sessionRpcFail === 0;
    log(allPass ? "✅ PASSED" : "❌ FAILURES — iOS session flow has race conditions");
    return allPass;
}


// === SCENARIO: high-concurrency ===
// 50 daemons connect + register simultaneously, then 50 callers blast RPCs.
// Saturates the event loop to expose auth.verifyToken race.
async function highConcurrency() {
    log("=== high-concurrency ===");
    log("50 daemons connect + register (no ack) simultaneously — stresses event loop");

    const NUM_DAEMONS = 50;
    const token = await getToken();

    // Launch ALL daemons in parallel — maximum pressure on event loop
    const daemonStartTime = Date.now();
    const daemonPromises = [];
    for (let i = 0; i < NUM_DAEMONS; i++) {
        const sessionId = `hc-${Date.now()}-${i}`;
        const method = `${sessionId}:echo`;
        daemonPromises.push(
            connect(token, { clientType: "session-scoped", sessionId })
                .then(daemon => {
                    daemon.on("rpc-request", (data, cb) => cb(data.params));
                    daemon.emit("rpc-register", { method });
                    return { daemon, method };
                })
                .catch(err => {
                    log(`  daemon ${i} failed to connect: ${err.message}`);
                    return null;
                })
        );
    }

    const daemonResults = await Promise.all(daemonPromises);
    const daemons = daemonResults.filter(d => d !== null);
    const connectTime = Date.now() - daemonStartTime;
    log(`${daemons.length}/${NUM_DAEMONS} daemons connected in ${connectTime}ms`);

    // Immediately blast RPCs to all daemons
    const callers = [];
    for (let i = 0; i < 5; i++) {
        callers.push(await connect(token, { clientType: "user-scoped" }));
    }

    let success = 0, fail = 0;
    const errors = new Map();

    // Each caller tries each daemon — massive parallel RPC blast
    const rpcPromises = [];
    for (const caller of callers) {
        for (const { method } of daemons) {
            rpcPromises.push(
                rpcCall(caller, method, "ping", 12_000).then(r => {
                    if (r.ok) success++;
                    else {
                        fail++;
                        errors.set(r.error, (errors.get(r.error) || 0) + 1);
                    }
                })
            );
        }
    }

    await Promise.all(rpcPromises);
    const total = daemons.length * callers.length;

    log(`\nResults: ${success}/${total} success, ${fail}/${total} fail`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);

    daemons.forEach(d => d.daemon.disconnect());
    callers.forEach(c => c.disconnect());

    log(fail === 0 ? "✅ PASSED" : "❌ FAILURES — high concurrency exposed registration race");
    return fail === 0;
}


// === SCENARIO: cross-replica-3pod ===
// With 3 replicas: daemon on pod A, ensure caller on pod C (not adjacent),
// verify cross-replica RPC routing with fire-and-forget registration.
async function crossReplica3Pod() {
    log("=== cross-replica-3pod ===");

    const pods = getPods();
    log(`Pods: ${pods.join(", ")} (${pods.length} replicas)`);
    if (pods.length < 3) {
        log("⚠️  Need 3+ replicas — skipping (scale up: kubectl scale deployment/handy-server --replicas=3)");
        return true;
    }

    const ROUNDS = 20;
    let success = 0, fail = 0;
    const errors = new Map();
    let crossPodCount = 0;

    for (let round = 0; round < ROUNDS; round++) {
        const token = await getToken();
        const sessionId = `x3-${Date.now()}-${round}`;
        const METHOD = `${sessionId}:echo`;

        // Connect daemon
        const daemon = await connect(token, { clientType: "session-scoped", sessionId });
        daemon.on("rpc-request", (data, cb) => cb(data.params));
        daemon.emit("rpc-register", { method: METHOD });

        await sleep(200);
        const daemonPod = findPodFor(daemon.id);

        // Try to get a caller on a DIFFERENT pod
        let caller, callerPod;
        for (let i = 0; i < 10; i++) {
            const c = await connect(token, { clientType: "user-scoped" });
            await sleep(100);
            const p = findPodFor(c.id);
            if (p !== daemonPod) {
                caller = c; callerPod = p; break;
            }
            c.disconnect();
        }
        if (!caller) {
            caller = await connect(token, { clientType: "user-scoped" });
            callerPod = daemonPod;
        }
        if (callerPod !== daemonPod) crossPodCount++;

        const r = await rpcCall(caller, METHOD, `round-${round}`, 12_000);
        if (r.ok) success++;
        else {
            fail++;
            errors.set(r.error, (errors.get(r.error) || 0) + 1);
        }

        daemon.disconnect();
        caller.disconnect();
    }

    log(`\nResults: ${success}/${ROUNDS} success, ${fail}/${ROUNDS} fail`);
    log(`Cross-pod calls: ${crossPodCount}/${ROUNDS}`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);
    log(fail === 0 ? "✅ PASSED" : "❌ FAILURES — 3-replica routing broken");
    return fail === 0;
}


// === SCENARIO: server-rolling-restart ===
// Simulates a production deployment: all pods restart one by one while daemons
// are connected. Verifies RPC availability through the restart window.
async function serverRollingRestart() {
    log("=== server-rolling-restart ===");
    log("Kill pods one by one (simulates deploy). Daemon must maintain RPC availability.");

    const token = await getToken();
    const sessionId = `roll-restart-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connect(token, {
        clientType: "session-scoped",
        sessionId,
        reconnection: true,
        reconnectionAttempts: 100,
    });
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    await awaitRegister(daemon, METHOD);
    log("daemon registered");

    const caller = await connect(token, {
        clientType: "user-scoped",
        reconnection: true,
        reconnectionAttempts: 100,
    });

    // Verify pre-restart
    const pre = await rpcCall(caller, METHOD, "pre-restart", 5_000);
    log(`pre-restart RPC: ok=${pre.ok}`);

    // Track daemon reconnects + re-register
    let reconnects = 0;
    daemon.on("connect", () => {
        reconnects++;
        daemon.emit("rpc-register", { method: METHOD });
        log(`daemon reconnected (#${reconnects}), re-registered (fire-and-forget)`);
    });

    // Get pods and kill them one at a time
    const pods = getPods();
    log(`Killing ${pods.length} pods one by one (rolling restart simulation)`);

    let success = 0, fail = 0;
    const errors = new Map();

    for (let i = 0; i < pods.length; i++) {
        log(`--- killing pod ${i + 1}/${pods.length}: ${pods[i]} ---`);
        try { kc(`delete pod ${pods[i]} --grace-period=1 --wait=false`); } catch {}

        // Poll RPC through the restart
        for (let sec = 1; sec <= 20; sec++) {
            await sleep(1000);
            const r = await rpcCall(caller, METHOD, `restart-${i}-${sec}`, 3_000);
            if (r.ok) success++;
            else {
                fail++;
                errors.set(r.error, (errors.get(r.error) || 0) + 1);
            }

            // Check if new pod is ready
            try {
                const currentPods = getPods().length;
                if (currentPods >= pods.length && sec > 5) {
                    log(`t+${sec}s: rpc ok=${r.ok} pods=${currentPods} — settled`);
                    break;
                }
                log(`t+${sec}s: rpc ok=${r.ok} pods=${currentPods}`);
            } catch {
                log(`t+${sec}s: rpc ok=${r.ok} pods=?`);
            }
        }
    }

    log(`\nResults: ${success} success, ${fail} fail, ${reconnects} daemon reconnects`);
    for (const [err, n] of errors) log(`  err: ${err} ×${n}`);

    daemon.disconnect();
    caller.disconnect();

    // Wait for cluster to stabilize
    try { kc("wait --for=condition=ready pod -l app=handy-server --timeout=120s"); } catch {}

    const failRate = fail / (success + fail);
    log(`Failure rate during rolling restart: ${(failRate * 100).toFixed(1)}%`);
    log(failRate < 0.3 ? "✅ PASSED (<30% failure during restart is acceptable)" : "❌ FAILED (>30% failure rate)");
    return failRate < 0.3;
}


// === main ===
const scenarios = {
    "fire-and-forget": fireAndForget,
    "register-race-timing": registerRaceTiming,
    "reconnect-no-ack": reconnectNoAck,
    "rapid-sessions": rapidSessions,
    "rolling-deploy": rollingDeploy,
    "stale-room-cleanup": staleRoomCleanup,
    "ios-session-flow": iosSessionFlow,
    "high-concurrency": highConcurrency,
    "cross-replica-3pod": crossReplica3Pod,
    "server-rolling-restart": serverRollingRestart,
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
    console.error(`usage: node deploy/integration-tests/stress-rpc-registration.mjs <${Object.keys(scenarios).join("|")}|all>`);
    process.exit(2);
}
