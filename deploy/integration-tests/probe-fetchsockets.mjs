// Probe: verify that io.in(roomName).fetchSockets() finds remote sockets
// across replicas via the Redis streams adapter, and that calling
// .timeout().emitWithAck() on a RemoteSocket works cross-pod.
//
// We can't run this from outside the cluster — fetchSockets is server-side.
// So we test it indirectly: connect a client that joins a custom room via
// a server probe endpoint, then call from another connection to trigger
// a server-side handler that does fetchSockets.
//
// SIMPLER ALTERNATIVE: just test the new rpc handler directly. It's the
// thing we care about. fetchSockets is internal to the server.
//
// This script is intentionally tiny — connect, register, call, measure.

import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync } from "child_process";

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
        body: JSON.stringify({ publicKey: base64(kp.publicKey), challenge: base64(ch), signature: base64(sig) }),
    });
    if (!r.ok) throw new Error(`auth ${r.status}`);
    return (await r.json()).token;
}

function findPod(socketId) {
    const pods = execSync(`kubectl get pods -l app=handy-server -o jsonpath='{.items[*].metadata.name}'`).toString().replace(/'/g, "").split(/\s+/).filter(Boolean);
    for (const p of pods) {
        try {
            const out = execSync(`kubectl logs ${p} --tail=2000 2>/dev/null`).toString();
            if (out.includes(socketId)) return p;
        } catch {}
    }
    return "?";
}

async function main() {
    const token = await getToken();
    const sessionId = `probe-fs-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    // Connect daemon
    const daemon = io(SERVER, { path: "/v1/updates", auth: { token, clientType: "session-scoped", sessionId }, transports: ["websocket"], reconnection: false });
    await new Promise((r) => daemon.once("connect", r));
    daemon.on("rpc-request", (data, cb) => cb({ echo: data.params, fromDaemon: daemon.id }));
    daemon.emit("rpc-register", { method: METHOD });
    await new Promise((r) => daemon.once("rpc-registered", r));
    const daemonPod = findPod(daemon.id);
    console.log(`daemon ${daemon.id} on ${daemonPod}`);

    // Connect a caller, retry until cross-pod
    let caller, callerPod;
    for (let i = 0; i < 30; i++) {
        const c = io(SERVER, { path: "/v1/updates", auth: { token, clientType: "user-scoped" }, transports: ["websocket"], reconnection: false });
        await new Promise((r) => c.once("connect", r));
        await sleep(150);
        const p = findPod(c.id);
        if (p !== daemonPod) { caller = c; callerPod = p; break; }
        c.disconnect();
    }
    if (!caller) {
        console.log("could not get cross-pod caller; running same-pod");
        caller = io(SERVER, { path: "/v1/updates", auth: { token, clientType: "user-scoped" }, transports: ["websocket"], reconnection: false });
        await new Promise((r) => caller.once("connect", r));
        callerPod = daemonPod;
    }
    console.log(`caller ${caller.id} on ${callerPod} (cross-pod=${callerPod !== daemonPod})`);

    // Make a single rpc-call. Time it.
    const start = Date.now();
    try {
        const result = await caller.timeout(5000).emitWithAck("rpc-call", { method: METHOD, params: "hello" });
        const lat = Date.now() - start;
        console.log(`call lat=${lat}ms result=${JSON.stringify(result).slice(0, 200)}`);
    } catch (e) {
        console.log(`call FAILED in ${Date.now() - start}ms: ${e.message}`);
    }

    // Now disconnect daemon and try the call again — measure fast-fail latency
    console.log("\n-- daemon gone, testing fast-fail --");
    daemon.disconnect();
    await sleep(500);  // give server a moment to clean up

    const t2 = Date.now();
    try {
        const r2 = await caller.timeout(5000).emitWithAck("rpc-call", { method: METHOD, params: "ghost" });
        console.log(`ghost call lat=${Date.now() - t2}ms result=${JSON.stringify(r2)}`);
    } catch (e) {
        console.log(`ghost call FAILED in ${Date.now() - t2}ms: ${e.message}`);
    }

    caller.disconnect();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
