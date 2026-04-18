// Network-loss test: connect daemon + caller, fire RPCs every 250ms in a loop,
// log every result. External script blocks/unblocks pod-Redis or pod-pod traffic
// while this is running. After SIGTERM/Ctrl-C we print a summary.

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

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s] ${m}`);

async function main() {
    const token = await getToken();
    const sessionId = `net-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    log("connecting daemon");
    const daemon = io(SERVER, { path: "/v1/updates", auth: { token, clientType: "session-scoped", sessionId }, transports: ["websocket"], reconnection: true, reconnectionDelay: 200, reconnectionDelayMax: 1000 });
    await new Promise((r) => daemon.once("connect", r));
    daemon.on("rpc-request", (data, cb) => cb(data.params));
    daemon.emit("rpc-register", { method: METHOD });
    await new Promise((r) => daemon.once("rpc-registered", r));
    log(`daemon ${daemon.id} registered, pod=${findPod(daemon.id)}`);

    log("connecting cross-pod caller");
    let caller, callerPod;
    const daemonPod = findPod(daemon.id);
    for (let i = 0; i < 20; i++) {
        const c = io(SERVER, { path: "/v1/updates", auth: { token, clientType: "user-scoped" }, transports: ["websocket"], reconnection: true });
        await new Promise((r) => c.once("connect", r));
        await sleep(150);
        const p = findPod(c.id);
        if (p !== daemonPod) {
            caller = c;
            callerPod = p;
            break;
        }
        c.disconnect();
    }
    if (!caller) {
        caller = io(SERVER, { path: "/v1/updates", auth: { token, clientType: "user-scoped" }, transports: ["websocket"], reconnection: true });
        await new Promise((r) => caller.once("connect", r));
        callerPod = daemonPod;
    }
    log(`caller ${caller.id}, pod=${callerPod} (cross-pod=${callerPod !== daemonPod})`);

    daemon.on("disconnect", (reason) => log(`!! daemon disconnect: ${reason}`));
    daemon.on("connect", () => {
        log(`!! daemon reconnected as ${daemon.id}, re-registering`);
        daemon.emit("rpc-register", { method: METHOD });
    });
    caller.on("disconnect", (reason) => log(`!! caller disconnect: ${reason}`));
    caller.on("connect", () => log(`!! caller reconnected as ${caller.id}`));

    const stats = { ok: 0, fail: 0, byErr: new Map() };
    let i = 0;
    const startLoop = async () => {
        while (true) {
            const start = Date.now();
            i++;
            try {
                const res = await caller.timeout(5_000).emitWithAck("rpc-call", { method: METHOD, params: `n${i}` });
                const lat = Date.now() - start;
                if (res.ok && res.result === `n${i}`) {
                    stats.ok++;
                    if (i % 10 === 0) log(`  rpc#${i} ok lat=${lat}ms`);
                } else {
                    stats.fail++;
                    const e = res.error || "wrong-result";
                    stats.byErr.set(e, (stats.byErr.get(e) || 0) + 1);
                    log(`  rpc#${i} FAIL lat=${lat}ms err=${e}`);
                }
            } catch (e) {
                stats.fail++;
                const err = e.message || String(e);
                stats.byErr.set(err, (stats.byErr.get(err) || 0) + 1);
                log(`  rpc#${i} FAIL lat=${Date.now() - start}ms err=${err}`);
            }
            await sleep(250);
        }
    };
    startLoop().catch((e) => log(`loop error: ${e.message}`));

    const print = () => {
        log(`\n=== SUMMARY ===`);
        log(`total=${i} ok=${stats.ok} fail=${stats.fail}`);
        for (const [err, n] of stats.byErr) log(`  ${err} ×${n}`);
        log(`daemonPod=${daemonPod} callerPod=${callerPod}`);
    };
    process.on("SIGTERM", () => { print(); process.exit(0); });
    process.on("SIGINT", () => { print(); process.exit(0); });

    // Auto-stop after 60s
    await sleep(60_000);
    print();
    daemon.disconnect();
    caller.disconnect();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
