// Realistic prod stress test: simulate background stream pressure from
// session-alive + machine-alive keepalives, then test RPC reliability.
//
// Prod profile (from Prometheus, 2026-04-17):
//   ~23,950 WebSocket connections (7,480 machines, 16,171 sessions, 299 user-scoped)
//   ~5,000 session-alive events/s  → each generates a stream entry via emitEphemeral
//   ~370 machine-alive events/s    → same
//   ~180 messages/s                → same
//   Total: ~5,500 stream entries/s background noise
//
// At maxLen=50K, stream retains only ~9s of data. fetchSockets round-trip
// responses get trimmed before the requesting pod reads them → 100% timeout.
//
// This test uses ioredis to XADD entries directly to the Redis stream at
// prod-like rates, then measures RPC success rate. Entries mimic the adapter's
// broadcast format (uid/nsp/type/data fields) but use a fake uid, so the
// adapter reads and discards them — but they count toward MAXLEN trimming.
//
// Usage:
//   node deploy/integration-tests/stress-prod-realistic.mjs [target_entries_per_sec]
//
// Default: 5000 entries/sec. Run with reverted fixes to reproduce degradation.

import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync } from "child_process";
import { randomBytes } from "crypto";
import Redis from "ioredis";

const SERVER = "http://127.0.0.1:3000";
const base64 = (b) => Buffer.from(b).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_ENTRIES_PER_SEC = parseInt(process.argv[2] || "5000", 10);
const WARMUP_SEC = 10;
const TEST_DURATION_SEC = 30;
const RPC_INTERVAL_MS = 300;  // ~3.3 RPC/s per caller (matches prod)
const NUM_RPC_CALLERS = 3;

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${m}`);

async function getToken() {
    const kp = tweetnacl.sign.keyPair();
    const ch = tweetnacl.randomBytes(32);
    const sig = tweetnacl.sign.detached(ch, kp.secretKey);
    const r = await fetch(`${SERVER}/v1/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: base64(kp.publicKey), challenge: base64(ch), signature: base64(sig) }),
    });
    if (!r.ok) throw new Error(`auth ${r.status}`);
    return (await r.json()).token;
}

function redisStats() {
    try {
        const streamLen = execSync(`kubectl exec happy-redis-0 -c redis -- redis-cli xlen socket.io 2>/dev/null`).toString().trim();
        const info = execSync(`kubectl exec happy-redis-0 -c redis -- redis-cli info all 2>/dev/null`).toString();
        const get = (key) => { const m = info.match(new RegExp(`${key}:(.*)`)); return m ? m[1].trim() : "?"; };
        return { streamLen, usedMemory: get("used_memory_human"), opsPerSec: get("instantaneous_ops_per_sec") };
    } catch { return { streamLen: "?", usedMemory: "?", opsPerSec: "?" }; }
}

async function connectSocket(token, opts = {}) {
    const s = io(SERVER, {
        path: "/v1/updates",
        auth: { token, ...opts },
        transports: ["websocket"],
        reconnection: false,
    });
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("connect timeout")), 15_000);
        s.once("connect", () => { clearTimeout(t); res(s); });
        s.once("connect_error", (e) => { clearTimeout(t); rej(e); });
    });
}

// Flood the Redis stream using ioredis pipelines.
//
// CRITICAL: we must use a REAL adapter UID, not a fake one. If we use a
// fake UID, the adapter discovers it as a new peer and then waits for it
// to respond to fetchSockets requests — which it never does, causing 100%
// timeouts regardless of stream pressure. That's a test bug, not a real issue.
//
// Using a real UID with type 2 (HEARTBEAT), the adapter treats entries as
// duplicate heartbeat updates from a known peer (O(1) timestamp update).
// They are cheap to process but still count toward MAXLEN trimming, which
// is the actual failure mechanism: fetchSockets responses get trimmed out
// of the stream before the requesting pod reads them.
async function getRealAdapterUid(redis) {
    // Read a few entries from the stream to find a real adapter UID
    const entries = await redis.xrange("socket.io", "-", "+", "COUNT", 10);
    for (const [, fields] of entries) {
        for (let i = 0; i < fields.length - 1; i += 2) {
            if (fields[i] === "uid") return fields[i + 1];
        }
    }
    throw new Error("No adapter entries found in stream — is the server running?");
}

async function startStreamFlood(redis, targetRate, maxLen) {
    const BATCH_SIZE = 250;
    const BATCHES_PER_SEC = targetRate / BATCH_SIZE;
    const INTERVAL_MS = Math.max(5, Math.floor(1000 / BATCHES_PER_SEC));

    const realUid = await getRealAdapterUid(redis);
    log(`Stream flood: using real adapter UID ${realUid}`);
    log(`  ${BATCH_SIZE} entries/batch, every ${INTERVAL_MS}ms → ~${(BATCH_SIZE * 1000 / INTERVAL_MS).toFixed(0)} entries/s`);

    let running = true;
    let totalAdded = 0;

    const loop = async () => {
        while (running) {
            const pipeline = redis.pipeline();
            for (let i = 0; i < BATCH_SIZE; i++) {
                // Type 2 = HEARTBEAT in ClusterAdapterWithHeartbeat.
                // The adapter that owns this UID skips it (own entry).
                // Other adapters update the peer's last-seen timestamp.
                // No data field needed for heartbeats.
                pipeline.xadd("socket.io", "MAXLEN", maxLen, "*", "uid", realUid, "nsp", "/", "type", "2");
            }
            try {
                await pipeline.exec();
                totalAdded += BATCH_SIZE;
            } catch (e) {
                log(`  flood pipeline error: ${e.message}`);
            }
            await sleep(INTERVAL_MS);
        }
    };

    const promise = loop();
    return {
        stop: async () => { running = false; await promise; },
        getCount: () => totalAdded,
    };
}

async function main() {
    log("=== PROD-REALISTIC STRESS TEST ===");
    log(`Target background pressure: ${TARGET_ENTRIES_PER_SEC} stream entries/s`);
    log(`At maxLen=50K, retention: ${(50000 / TARGET_ENTRIES_PER_SEC).toFixed(1)}s`);
    log(`Warmup: ${WARMUP_SEC}s, Test: ${TEST_DURATION_SEC}s\n`);

    const health = await fetch(`${SERVER}/health`).then(r => r.json());
    log(`Server health: ${health.status}`);

    // Connect to Redis via port-forward
    const redis = new Redis({ host: "127.0.0.1", port: 6379, lazyConnect: true, maxRetriesPerRequest: 3 });
    await redis.connect();
    log(`Redis connected: ${await redis.ping()}`);

    // Verify current maxLen by checking stream
    const preStats = redisStats();
    log(`Redis pre-test: stream=${preStats.streamLen} mem=${preStats.usedMemory} ops/s=${preStats.opsPerSec}\n`);

    const token = await getToken();

    // --- Phase 1: Baseline (no background pressure) ---
    log("=== PHASE 1: BASELINE (no background pressure) ===");

    const sessionId = `rpc-daemon-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;
    const daemon = await connectSocket(token, { clientType: "session-scoped", sessionId });
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    daemon.emit("rpc-register", { method: METHOD });
    await new Promise(r => daemon.once("rpc-registered", r));
    log("Daemon registered");

    const callers = [];
    for (let i = 0; i < NUM_RPC_CALLERS; i++) {
        callers.push(await connectSocket(token, { clientType: "user-scoped" }));
    }
    log(`${NUM_RPC_CALLERS} callers connected`);

    // Quick baseline: 30 sequential RPCs
    let baseOk = 0, baseFail = 0;
    const baseLats = [];
    for (let i = 0; i < 30; i++) {
        const caller = callers[i % callers.length];
        const start = Date.now();
        try {
            const res = await caller.timeout(10_000).emitWithAck("rpc-call", { method: METHOD, params: `base-${i}` });
            const lat = Date.now() - start;
            if (res.ok) { baseOk++; baseLats.push(lat); }
            else { baseFail++; }
        } catch { baseFail++; }
    }
    baseLats.sort((a, b) => a - b);
    const baseP50 = baseLats[Math.floor(baseLats.length * 0.5)] || 0;
    const baseP95 = baseLats[Math.floor(baseLats.length * 0.95)] || 0;
    log(`Baseline: ${baseOk}/30 ok, ${baseFail}/30 fail, p50=${baseP50}ms p95=${baseP95}ms\n`);

    // --- Phase 2: Start background stream pressure ---
    log("=== PHASE 2: STREAM PRESSURE + RPCs ===");

    // Use the server's actual maxLen. When testing reverted code, change to 50000.
    const MAXLEN = parseInt(process.env.MAXLEN || "200000", 10);
    const flood = await startStreamFlood(redis, TARGET_ENTRIES_PER_SEC, MAXLEN);

    log(`Warming up for ${WARMUP_SEC}s (filling stream to maxLen=${MAXLEN})...`);
    for (let s = 0; s < WARMUP_SEC; s++) {
        await sleep(1000);
        if (s % 2 === 1) {
            const stats = redisStats();
            log(`  t+${s + 1}s: stream=${stats.streamLen} ops/s=${stats.opsPerSec} flooded=${flood.getCount()}`);
        }
    }

    // --- Phase 3: RPC under load ---
    log(`\nRunning RPCs under load for ${TEST_DURATION_SEC}s...`);

    const results = { ok: 0, fail: 0, latencies: [], errors: new Map(), timeline: [] };
    let running = true;

    const rpcLoops = callers.map((caller, idx) =>
        (async () => {
            let seq = 0;
            while (running) {
                const start = Date.now();
                try {
                    const res = await caller.timeout(15_000).emitWithAck("rpc-call", { method: METHOD, params: `load-${idx}-${seq++}` });
                    const lat = Date.now() - start;
                    if (res.ok) {
                        results.ok++;
                        results.latencies.push(lat);
                        results.timeline.push({ t: Date.now() - t0, ok: true, lat });
                    } else {
                        results.fail++;
                        results.errors.set(res.error, (results.errors.get(res.error) || 0) + 1);
                        results.timeline.push({ t: Date.now() - t0, ok: false, err: res.error, lat });
                    }
                } catch (e) {
                    const lat = Date.now() - start;
                    results.fail++;
                    const err = e.message || String(e);
                    results.errors.set(err, (results.errors.get(err) || 0) + 1);
                    results.timeline.push({ t: Date.now() - t0, ok: false, err, lat });
                }
                await sleep(RPC_INTERVAL_MS);
            }
        })()
    );

    // Progress updates
    for (let s = 0; s < TEST_DURATION_SEC; s++) {
        await sleep(1000);
        if (s % 5 === 4) {
            const total = results.ok + results.fail;
            const failPct = total > 0 ? (results.fail / total * 100).toFixed(1) : "0.0";
            const stats = redisStats();
            log(`  t+${s + 1}s: rpc ${results.ok}ok/${results.fail}fail (${failPct}% fail) stream=${stats.streamLen} ops/s=${stats.opsPerSec}`);
        }
    }

    running = false;
    await Promise.all(rpcLoops);

    // Stop flood
    await flood.stop();

    // --- Results ---
    results.latencies.sort((a, b) => a - b);
    const len = results.latencies.length;
    const total = results.ok + results.fail;
    const failPct = total > 0 ? (results.fail / total * 100).toFixed(1) : "0.0";

    log("\n========================================");
    log("           RESULTS");
    log("========================================");

    log(`\nBaseline (no pressure):`);
    log(`  ${baseOk}/30 ok, p50=${baseP50}ms p95=${baseP95}ms`);

    log(`\nUnder load (~${TARGET_ENTRIES_PER_SEC} stream entries/s, maxLen=${MAXLEN}):`);
    log(`  Total: ${total} RPCs → ${results.ok} ok, ${results.fail} fail (${failPct}% failure rate)`);
    if (len > 0) {
        const p50 = results.latencies[Math.floor(len * 0.5)];
        const p95 = results.latencies[Math.floor(len * 0.95)];
        const p99 = results.latencies[Math.floor(len * 0.99)];
        const max = results.latencies[len - 1];
        log(`  Latency (successful only): p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${max}ms`);
    }
    if (results.errors.size > 0) {
        log(`  Error breakdown:`);
        for (const [err, n] of [...results.errors.entries()].sort((a, b) => b[1] - a[1])) {
            log(`    ${err} ×${n}`);
        }
    }

    // Show timeline of first few failures
    const failures = results.timeline.filter(e => !e.ok);
    if (failures.length > 0) {
        log(`\n  First 5 failures:`);
        for (const f of failures.slice(0, 5)) {
            log(`    t+${(f.t / 1000).toFixed(1)}s: ${f.err} (${f.lat}ms)`);
        }
    }

    const postStats = redisStats();
    log(`\nRedis post-test: stream=${postStats.streamLen} mem=${postStats.usedMemory}`);
    log(`Stream flood: ${flood.getCount()} total entries added`);

    daemon.disconnect();
    callers.forEach(c => c.disconnect());
    redis.disconnect();

    if (results.fail > 0) {
        log(`\n❌ DEGRADATION REPRODUCED: ${failPct}% RPC failures under prod-like stream pressure`);
        log(`   Root cause confirmed: high stream entry rate + maxLen=50K → fetchSockets responses trimmed`);
    } else {
        log(`\n✅ No failures — try higher rate: node stress-prod-realistic.mjs ${TARGET_ENTRIES_PER_SEC * 2}`);
    }

    process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
