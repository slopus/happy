import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync, spawn } from "child_process";

const SERVER = "http://127.0.0.1:3000";
const base64 = (buf) => Buffer.from(buf).toString("base64");

async function getToken() {
    const keyPair = tweetnacl.sign.keyPair();
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keyPair.secretKey);
    const res = await fetch(`${SERVER}/v1/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            publicKey: base64(keyPair.publicKey),
            challenge: base64(challenge),
            signature: base64(signature),
        }),
    });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    return (await res.json()).token;
}

function getPods() {
    return execSync("kubectl get pods -l app=handy-server -o jsonpath='{.items[*].metadata.name}'")
        .toString().replace(/'/g, "").trim().split(/\s+/);
}

function findSocketPod(socketId, pods) {
    for (const pod of pods) {
        const logs = execSync(`kubectl logs ${pod} --tail=500 2>/dev/null`).toString();
        if (logs.includes(socketId)) return pod;
    }
    return null;
}

function waitForPodReady(label, timeoutSec = 60) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        try {
            const out = execSync(
                `kubectl get pods -l ${label} -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}'`
            ).toString().replace(/'/g, "").trim();
            const statuses = out.split(/\s+/);
            if (statuses.length > 0 && statuses.every(s => s === "True")) return true;
        } catch {}
        execSync("sleep 2");
    }
    return false;
}

function connectSocket(token, opts = {}, serverUrl = SERVER) {
    const socket = io(serverUrl, {
        path: "/v1/updates",
        auth: { token, ...opts },
        transports: ["websocket"],
        reconnection: false,
    });
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("connect timeout")), 10000);
        socket.on("connect", () => { clearTimeout(timeout); resolve(socket); });
        socket.on("connect_error", (err) => { clearTimeout(timeout); reject(err); });
    });
}

// Port-forward to a specific pod on a given local port. Returns a cleanup function.
function portForwardPod(pod, localPort) {
    const child = spawn("kubectl", ["port-forward", pod, `${localPort}:3005`], {
        stdio: "pipe",
        detached: true,
    });
    child.unref();
    return { url: `http://127.0.0.1:${localPort}`, kill: () => { try { process.kill(-child.pid); } catch {} } };
}

// ---------------------------------------------------------------------------
// Test 1: Baseline — normal RPC works
// ---------------------------------------------------------------------------
async function testBaseline(token) {
    const sessionId = `baseline-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = await connectSocket(token, { clientType: "session-scoped", sessionId });
    daemon.emit("rpc-register", { method: METHOD });
    daemon.on("rpc-request", (data, callback) => callback(data.params));
    await new Promise(r => setTimeout(r, 500));

    const caller = await connectSocket(token, { clientType: "user-scoped" });
    const t0 = Date.now();
    const result = await caller.timeout(10000).emitWithAck("rpc-call", {
        method: METHOD,
        params: "hello",
    });
    const elapsed = Date.now() - t0;

    daemon.disconnect();
    caller.disconnect();

    if (!result.ok || result.result !== "hello") {
        console.log(`  FAIL: unexpected result: ${JSON.stringify(result)}`);
        return false;
    }
    console.log(`  RPC succeeded in ${elapsed}ms`);
    return true;
}

// ---------------------------------------------------------------------------
// Test 2: Clean client disconnect (daemon.disconnect()) — NOT a pod kill
//         This is the easy case. Socket.IO processes it immediately.
// ---------------------------------------------------------------------------
async function testCleanDisconnect(token) {
    const sessionId = `clean-${Date.now()}`;
    const METHOD = `${sessionId}:slowecho`;

    const daemon = await connectSocket(token, { clientType: "session-scoped", sessionId });
    daemon.emit("rpc-register", { method: METHOD });
    daemon.on("rpc-request", () => {}); // never respond
    await new Promise(r => setTimeout(r, 500));

    const caller = await connectSocket(token, { clientType: "user-scoped" });
    const t0 = Date.now();
    const rpcPromise = caller.timeout(35000).emitWithAck("rpc-call", {
        method: METHOD,
        params: "should-never-arrive",
    });

    await new Promise(r => setTimeout(r, 1000));
    daemon.disconnect();
    console.log(`  Daemon cleanly disconnected after ${Date.now() - t0}ms`);

    const result = await rpcPromise;
    const elapsed = Date.now() - t0;
    caller.disconnect();

    console.log(`  RPC failed after ${elapsed}ms: "${result.error}"`);
    console.log(`  Detection mechanism: ${result.error === "RPC target disconnected" ? "PRESENCE POLL" : "EMIT_WITH_ACK / OTHER"}`);

    if (!result.ok && elapsed < 15000) {
        console.log(`  Fast failure (${(elapsed / 1000).toFixed(1)}s) — but this is the EASY case (clean disconnect)`);
        return true;
    }
    console.log(`  FAIL: took ${elapsed}ms or unexpected result: ${JSON.stringify(result)}`);
    return false;
}

// ---------------------------------------------------------------------------
// Test 3: HARD KILL — delete the pod the daemon is on
//         Connect daemon and caller to DIFFERENT pods via separate
//         port-forwards. Then kill the daemon's pod. The caller's pod
//         must detect the dead daemon cross-replica.
// ---------------------------------------------------------------------------
async function testPodKill(token) {
    const pods = getPods();
    if (pods.length < 2) {
        console.log(`  SKIP: need >= 2 pods for pod-kill test (have ${pods.length})`);
        return true;
    }

    const daemonPod = pods[0];
    const callerPod = pods[1];
    console.log(`  Daemon pod: ${daemonPod}`);
    console.log(`  Caller pod: ${callerPod}`);

    // Port-forward each pod on a separate local port
    const daemonPf = portForwardPod(daemonPod, 4001);
    const callerPf = portForwardPod(callerPod, 4002);
    await new Promise(r => setTimeout(r, 2000)); // let port-forwards establish

    try {
        const sessionId = `podkill-${Date.now()}`;
        const METHOD = `${sessionId}:slowecho`;

        // Connect daemon directly to its pod
        const daemon = await connectSocket(token, { clientType: "session-scoped", sessionId }, daemonPf.url);
        daemon.emit("rpc-register", { method: METHOD });
        daemon.on("rpc-request", () => {}); // never respond
        console.log(`  Daemon socket: ${daemon.id} → ${daemonPod}`);
        await new Promise(r => setTimeout(r, 1000)); // let registration propagate

        // Connect caller directly to the OTHER pod
        const caller = await connectSocket(token, { clientType: "user-scoped" }, callerPf.url);
        console.log(`  Caller socket: ${caller.id} → ${callerPod}`);
        console.log(`  Cross-replica: YES (guaranteed)`);

        // Start the RPC call on the caller's pod — server must find daemon cross-replica
        const t0 = Date.now();
        const rpcPromise = caller.timeout(45000).emitWithAck("rpc-call", {
            method: METHOD,
            params: "should-never-arrive",
        }).catch(err => ({ ok: false, error: err.message }));

        // Kill the daemon's pod (hard kill, no graceful shutdown)
        await new Promise(r => setTimeout(r, 2000)); // let RPC get in-flight
        console.log(`  KILLING pod ${daemonPod} (force, grace-period=0)...`);
        try {
            execSync(`kubectl delete pod ${daemonPod} --force --grace-period=0 2>&1`);
        } catch (e) {
            console.log(`  kubectl delete output: ${e.stdout?.toString() || e.message}`);
        }
        const killTime = Date.now() - t0;
        console.log(`  Pod killed at ${killTime}ms`);

        // Wait for the RPC to resolve
        const result = await rpcPromise;
        const elapsed = Date.now() - t0;
        const detectionTime = elapsed - killTime;
        try { caller.disconnect(); } catch {}

        console.log(`  RPC resolved after ${elapsed}ms (${detectionTime}ms after pod kill)`);
        console.log(`  Result: ok=${result.ok}, error="${result.error}"`);

        if (result.error === "RPC target disconnected") {
            console.log(`  Detection: PRESENCE POLL caught it in ${(detectionTime / 1000).toFixed(1)}s`);
        } else if (result.error === "RPC method not available") {
            console.log(`  Detection: GRACE WINDOW exhausted — room went empty after pod death`);
        } else if (result.error?.includes("timeout") || elapsed >= 29000) {
            console.log(`  Detection: FULL TIMEOUT — presence poll did NOT help (${(elapsed / 1000).toFixed(1)}s)`);
        } else {
            console.log(`  Detection: UNKNOWN mechanism — error: "${result.error}"`);
        }

        // Wait for replacement pod
        console.log(`  Waiting for replacement pod...`);
        waitForPodReady("app=handy-server", 90);
        await new Promise(r => setTimeout(r, 3000));

        if (!result.ok && elapsed < 20000) {
            console.log(`  Pod-kill detected in ${(detectionTime / 1000).toFixed(1)}s (< 20s threshold)`);
            return true;
        }
        if (!result.ok && elapsed >= 20000) {
            console.log(`  SLOW: ${(elapsed / 1000).toFixed(1)}s — poll may not be helping much`);
            return false;
        }
        return false;
    } finally {
        daemonPf.kill();
        callerPf.kill();
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log("=== RPC DEAD-DAEMON DETECTION TEST ===\n");

    const health = await fetch(`${SERVER}/health`).then(r => r.json());
    const pods = getPods();
    console.log(`Health: ${health.status}`);
    console.log(`Pods: ${pods.join(", ")} (${pods.length} replicas)\n`);

    const token = await getToken();
    let allPassed = true;

    // Test 1: baseline
    console.log("Test 1: Baseline RPC ...");
    const t1 = await testBaseline(token);
    console.log(t1 ? "  PASS\n" : "  FAIL\n");
    allPassed = allPassed && t1;

    // Test 2: clean disconnect (easy case)
    console.log("Test 2: Clean client disconnect ...");
    const t2 = await testCleanDisconnect(token);
    console.log(t2 ? "  PASS\n" : "  FAIL\n");
    allPassed = allPassed && t2;

    // Test 3: THE REAL TEST — kill the pod
    console.log("Test 3: Pod kill (hard) ...");
    const t3 = await testPodKill(token);
    console.log(t3 ? "  PASS\n" : "  FAIL\n");
    allPassed = allPassed && t3;

    console.log("========================================");
    console.log("           VERDICT");
    console.log("========================================");
    console.log(allPassed ? "ALL PASSED" : "FAILURES DETECTED");
    process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
    console.error("Test failed:", err.message);
    process.exit(1);
});
