// Ramped stress test: gradually increase RPC load and monitor behavior.
//
// Ramps through stages of increasing daemon+caller counts, each running
// sustained RPCs for a configurable duration. Prints per-stage stats
// (throughput, latency, failure rate) and polls Redis metrics throughout.
//
// Usage:
//   node deploy/integration-tests/stress-ramp.mjs [duration_per_stage_sec]
//
// Default: 15s per stage. Stages: 5 → 10 → 20 → 40 daemons, each with
// its own caller firing RPCs every 100ms (~10 RPC/sec per pair).

import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync } from "child_process";

const SERVER = "http://127.0.0.1:3000";
const base64 = (b) => Buffer.from(b).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STAGE_DURATION_SEC = parseInt(process.argv[2] || "15", 10);
const STAGES = [5, 10, 20, 40];
const RPC_INTERVAL_MS = 100; // 10 RPC/sec per daemon-caller pair

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

function redisCmd(cmd) {
    try {
        return execSync(`kubectl exec happy-redis-0 -c redis -- redis-cli ${cmd} 2>/dev/null`).toString().trim();
    } catch { return "?"; }
}

function getRedisStats() {
    const streamLen = redisCmd("xlen socket.io");
    const info = execSync(`kubectl exec happy-redis-0 -c redis -- redis-cli info all 2>/dev/null`).toString();
    const get = (key) => { const m = info.match(new RegExp(`${key}:(.*)`)); return m ? m[1].trim() : "?"; };
    return {
        streamLen,
        usedMemory: get("used_memory_human"),
        opsPerSec: get("instantaneous_ops_per_sec"),
        connectedClients: get("connected_clients"),
        blockedClients: get("blocked_clients"),
    };
}

async function connectSocket(token, opts = {}) {
    const s = io(SERVER, {
        path: "/v1/updates",
        auth: { token, ...opts },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 200,
        reconnectionDelayMax: 2000,
    });
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("connect timeout")), 15_000);
        s.once("connect", () => { clearTimeout(t); res(s); });
        s.once("connect_error", (e) => { clearTimeout(t); rej(e); });
    });
}

async function runStage(numPairs, durationSec) {
    const token = await getToken();
    const pairs = [];

    // Connect daemon-caller pairs
    for (let i = 0; i < numPairs; i++) {
        const sessionId = `stress-${Date.now()}-${i}`;
        const method = `${sessionId}:echo`;

        const daemon = await connectSocket(token, { clientType: "session-scoped", sessionId });
        daemon.on("rpc-request", (data, cb) => cb(data.params));
        daemon.emit("rpc-register", { method });

        const caller = await connectSocket(token, { clientType: "user-scoped" });
        pairs.push({ daemon, caller, method });
    }

    // Wait for registrations to settle
    await sleep(500);

    const stats = { ok: 0, fail: 0, latencies: [], errors: new Map() };
    let running = true;

    // Start RPC loops for all pairs
    const loops = pairs.map(({ caller, method }, idx) =>
        (async () => {
            let seq = 0;
            while (running) {
                const start = Date.now();
                try {
                    const res = await caller.timeout(10_000).emitWithAck("rpc-call", { method, params: `s${seq++}` });
                    const lat = Date.now() - start;
                    if (res.ok) {
                        stats.ok++;
                        stats.latencies.push(lat);
                    } else {
                        stats.fail++;
                        stats.errors.set(res.error, (stats.errors.get(res.error) || 0) + 1);
                    }
                } catch (e) {
                    stats.fail++;
                    const err = e.message || String(e);
                    stats.errors.set(err, (stats.errors.get(err) || 0) + 1);
                }
                await sleep(RPC_INTERVAL_MS);
            }
        })()
    );

    // Run for the stage duration, sampling Redis metrics periodically
    const redisSnapshots = [];
    const sampleInterval = Math.max(3000, durationSec * 200); // sample every ~3s minimum
    const deadline = Date.now() + durationSec * 1000;

    while (Date.now() < deadline) {
        await sleep(sampleInterval);
        redisSnapshots.push(getRedisStats());
    }

    running = false;
    await Promise.all(loops);

    // Disconnect all
    for (const { daemon, caller } of pairs) {
        daemon.disconnect();
        caller.disconnect();
    }

    // Compute latency percentiles
    stats.latencies.sort((a, b) => a - b);
    const len = stats.latencies.length;
    const p50 = len > 0 ? stats.latencies[Math.floor(len * 0.5)] : 0;
    const p95 = len > 0 ? stats.latencies[Math.floor(len * 0.95)] : 0;
    const p99 = len > 0 ? stats.latencies[Math.floor(len * 0.99)] : 0;
    const max = len > 0 ? stats.latencies[len - 1] : 0;
    const total = stats.ok + stats.fail;
    const rps = total / durationSec;

    return { total, ok: stats.ok, fail: stats.fail, rps, p50, p95, p99, max, errors: stats.errors, redisSnapshots };
}

async function main() {
    log("=== RAMPED STRESS TEST ===");
    log(`Stages: ${STAGES.join(" → ")} daemon-caller pairs`);
    log(`Duration per stage: ${STAGE_DURATION_SEC}s`);
    log(`RPC interval: ${RPC_INTERVAL_MS}ms per pair (~${(1000 / RPC_INTERVAL_MS).toFixed(0)} RPC/s/pair)\n`);

    const health = await fetch(`${SERVER}/health`).then(r => r.json());
    log(`Server health: ${health.status}`);
    const preRedis = getRedisStats();
    log(`Redis pre-test: stream=${preRedis.streamLen} mem=${preRedis.usedMemory} ops/s=${preRedis.opsPerSec} clients=${preRedis.connectedClients}\n`);

    const results = [];

    for (const numPairs of STAGES) {
        const targetRps = numPairs * (1000 / RPC_INTERVAL_MS);
        log(`--- STAGE: ${numPairs} pairs (target ~${targetRps.toFixed(0)} RPC/s) for ${STAGE_DURATION_SEC}s ---`);

        const result = await runStage(numPairs, STAGE_DURATION_SEC);
        const failRate = result.total > 0 ? (result.fail / result.total * 100).toFixed(1) : "0.0";
        const lastRedis = result.redisSnapshots.length > 0 ? result.redisSnapshots[result.redisSnapshots.length - 1] : getRedisStats();

        log(`  RPCs: ${result.ok}/${result.total} ok (${failRate}% fail) @ ${result.rps.toFixed(1)} RPC/s`);
        log(`  Latency: p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms max=${result.max}ms`);
        log(`  Redis: stream=${lastRedis.streamLen} mem=${lastRedis.usedMemory} ops/s=${lastRedis.opsPerSec} clients=${lastRedis.connectedClients} blocked=${lastRedis.blockedClients}`);
        if (result.errors.size > 0) {
            for (const [err, n] of result.errors) log(`  Error: ${err} ×${n}`);
        }
        log("");

        results.push({ pairs: numPairs, ...result, failRate: parseFloat(failRate) });

        // Brief cooldown between stages
        await sleep(2000);
    }

    // Summary table
    log("========================================");
    log("           SUMMARY");
    log("========================================");
    log("  Pairs  RPC/s    OK     Fail   Fail%   p50    p95    p99    max");
    for (const r of results) {
        log(`  ${String(r.pairs).padStart(5)}  ${r.rps.toFixed(1).padStart(5)}  ${String(r.ok).padStart(5)}  ${String(r.fail).padStart(6)}  ${r.failRate.toFixed(1).padStart(5)}%  ${String(r.p50).padStart(4)}ms  ${String(r.p95).padStart(4)}ms  ${String(r.p99).padStart(4)}ms  ${String(r.max).padStart(5)}ms`);
    }

    const postRedis = getRedisStats();
    log(`\nRedis post-test: stream=${postRedis.streamLen} mem=${postRedis.usedMemory} ops/s=${postRedis.opsPerSec} clients=${postRedis.connectedClients}`);

    const anyFail = results.some(r => r.failRate > 5);
    log(anyFail ? "\n❌ DEGRADATION DETECTED (>5% failure at some stage)" : "\n✅ ALL STAGES PASSED (<5% failure)");
    process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
