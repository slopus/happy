import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync } from "child_process";

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
    return "unknown";
}

function connectSocket(token, opts = {}) {
    const socket = io(SERVER, {
        path: "/v1/updates",
        auth: { token, ...opts },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: 20,
    });
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("connect timeout")), 10000);
        socket.on("connect", () => { clearTimeout(timeout); resolve(socket); });
        socket.on("connect_error", (err) => { clearTimeout(timeout); reject(err); });
    });
}

async function test() {
    console.log("=== RPC CROSS-REPLICA TEST ===\n");

    const health = await fetch(`${SERVER}/health`).then(r => r.json());
    console.log(`Health: ${health.status}`);
    const pods = getPods();
    console.log(`Pods: ${pods.join(", ")} (${pods.length} replicas)\n`);

    const token = await getToken();

    // 1. Connect a "daemon" socket (session-scoped) that will handle RPCs
    const METHOD = `test-session-${Date.now()}:echo`;
    const daemon = await connectSocket(token, { clientType: "session-scoped", sessionId: `test-session-${Date.now()}` });

    // Register an RPC handler
    daemon.emit("rpc-register", { method: METHOD });
    daemon.on("rpc-request", (data, callback) => {
        // Echo back the params
        callback(data.params);
    });
    await new Promise(r => setTimeout(r, 500));

    // 2. Connect multiple "web app" sockets (user-scoped) that will call RPCs
    const NUM_CALLERS = 10;
    const callers = [];
    for (let i = 0; i < NUM_CALLERS; i++) {
        callers.push(await connectSocket(token, { clientType: "user-scoped" }));
    }

    await new Promise(r => setTimeout(r, 2000));

    // Check pod distribution
    const daemonPod = findSocketPod(daemon.id, pods);
    console.log(`Daemon socket: ${daemon.id} → ${daemonPod}`);
    const callerPods = {};
    for (const c of callers) {
        const pod = findSocketPod(c.id, pods);
        callerPods[pod] = (callerPods[pod] || 0) + 1;
    }
    console.log(`Caller distribution: ${JSON.stringify(callerPods)}`);

    const crossReplica = Object.keys(callerPods).some(p => p !== daemonPod);
    console.log(`Cross-replica callers: ${crossReplica ? "YES" : "NO (all on same pod)"}\n`);

    // 3. Hammer RPC calls from all callers
    const CALLS_PER_CALLER = 5;
    const TOTAL = NUM_CALLERS * CALLS_PER_CALLER;
    let success = 0;
    let fail = 0;
    const errors = [];

    console.log(`--- Sending ${TOTAL} RPC calls (${CALLS_PER_CALLER} per caller) ---`);

    const promises = [];
    for (const caller of callers) {
        for (let i = 0; i < CALLS_PER_CALLER; i++) {
            const payload = `ping-${i}`;
            promises.push(
                new Promise((resolve) => {
                    caller.timeout(10000).emitWithAck("rpc-call", {
                        method: METHOD,
                        params: payload,
                    }).then((result) => {
                        if (result.ok && result.result === payload) {
                            success++;
                        } else {
                            fail++;
                            errors.push(result.error || "unexpected result");
                        }
                        resolve();
                    }).catch((err) => {
                        fail++;
                        errors.push(err.message);
                        resolve();
                    });
                })
            );
        }
    }

    await Promise.all(promises);

    console.log(`  Success: ${success}/${TOTAL}`);
    console.log(`  Failed:  ${fail}/${TOTAL}`);
    if (errors.length > 0) {
        const uniq = [...new Set(errors)];
        console.log(`  Errors:  ${uniq.join(", ")}`);
    }

    // 4. Sequential calls to test consistency
    console.log(`\n--- Sequential RPC calls (20x) ---`);
    let seqSuccess = 0;
    let seqFail = 0;
    const seqErrors = [];
    for (let i = 0; i < 20; i++) {
        const caller = callers[i % callers.length];
        try {
            const result = await caller.timeout(10000).emitWithAck("rpc-call", {
                method: METHOD,
                params: `seq-${i}`,
            });
            if (result.ok) seqSuccess++;
            else { seqFail++; seqErrors.push(result.error); }
        } catch (err) {
            seqFail++;
            seqErrors.push(err.message);
        }
    }
    console.log(`  Success: ${seqSuccess}/20`);
    console.log(`  Failed:  ${seqFail}/20`);
    if (seqErrors.length > 0) console.log(`  Errors:  ${[...new Set(seqErrors)].join(", ")}`);

    // Verdict
    console.log("\n========================================");
    console.log("           VERDICT");
    console.log("========================================");
    console.log(`Replicas:       ${pods.length}`);
    console.log(`Cross-replica:  ${crossReplica ? "YES" : "NO"}`);
    console.log(`Parallel RPCs:  ${success}/${TOTAL} passed`);
    console.log(`Sequential:     ${seqSuccess}/20 passed`);
    console.log(success === TOTAL && seqSuccess === 20 ? "✅ ALL PASSED" : "❌ FAILURES DETECTED");

    daemon.disconnect();
    for (const c of callers) c.disconnect();
    process.exit(success === TOTAL && seqSuccess === 20 ? 0 : 1);
}

test().catch((err) => {
    console.error("Test failed:", err.message);
    process.exit(1);
});
