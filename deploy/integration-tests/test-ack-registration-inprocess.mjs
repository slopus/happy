// In-process evidence test for issue #1118
//
// Simulates Redis adapter latency by wrapping socket.join() with async delay.
// Proves fire-and-forget registration drops calls while await-ack does not.
//
// Usage: node deploy/integration-tests/test-ack-registration-inprocess.mjs

import { Server } from "socket.io";
import { io as ioc } from "socket.io-client";

const JOIN_DELAY_MS = 50; // simulate Redis adapter cross-replica sync latency

// --- Create server with delayed join (simulates Redis adapter) ---

const ioServer = new Server({
    pingInterval: 10000,
    pingTimeout: 5000,
});

import http from "http";

const httpServer = http.createServer();
ioServer.attach(httpServer, { path: "/v1/updates" });

// Remove adapter patch — instead delay join directly in the handler

// Auth middleware (minimal — just sets userId)
ioServer.use((socket, next) => {
    socket.data.userId = "test-user";
    next();
});

// RPC handler (same logic as production rpcHandler.ts)
ioServer.on("connection", (socket) => {
    const userId = socket.data.userId;

    socket.on("rpc-register", (data) => {
        const { method } = data ?? {};
        if (!method) return;
        // Simulate async Redis adapter: join and ack are delayed
        setTimeout(() => {
            socket.join(`rpc:${userId}:${method}`);
            socket.emit("rpc-registered", { method });
        }, JOIN_DELAY_MS);
    });

    socket.on("rpc-call", (data, callback) => {
        const { method, params } = data ?? {};
        if (!method) { callback?.({ ok: false, error: "no method" }); return; }
        const room = `rpc:${userId}:${method}`;
        const sockets = ioServer.sockets.adapter.rooms.get(room);
        if (!sockets || sockets.size === 0) {
            callback?.({ ok: false, error: "RPC method not available" });
            return;
        }
        // Find a target that isn't the caller
        for (const sid of sockets) {
            if (sid !== socket.id) {
                const target = ioServer.sockets.sockets.get(sid);
                if (target) {
                    target.timeout(5000).emitWithAck("rpc-request", { method, params })
                        .then((resp) => callback?.({ ok: true, result: resp }))
                        .catch((e) => callback?.({ ok: false, error: e.message }));
                    return;
                }
            }
        }
        callback?.({ ok: false, error: "no target" });
    });
});

// --- Test runner ---

const ROUNDS = 30;

function createClient(type, extra = {}) {
    return new Promise((resolve, reject) => {
        const s = ioc("http://127.0.0.1:0", {
            transports: ["websocket"],
            autoConnect: false,
            auth: { token: "test", clientType: type, ...extra },
        });
        // Override to connect to our in-process server
        s.io.engine.opts = s.io.engine.opts || {};

        // We need to connect through the server directly
        const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
        s.on("connect", () => { clearTimeout(timer); resolve(s); });
        s.on("connect_error", (e) => { clearTimeout(timer); reject(e); });

        // Monkey-patch: connect directly to our server
        s.io.engine = { close: () => {} }; // dummy
        // Actually use server-side attach
        reject(new Error("use server attach"));
    });
}

// --- Better approach: use server.sockets.on("connection") and ioServer.attach ---

await new Promise(r => httpServer.listen(0, r));
const port = httpServer.address().port;

console.log(`In-process server on port ${port}, join delay = ${JOIN_DELAY_MS}ms\n`);

function connectToServer(type, extra = {}) {
    return new Promise((resolve, reject) => {
        const s = ioc(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: { token: "test", clientType: type, ...extra },
        });
        const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
        s.once("connect", () => { clearTimeout(timer); resolve(s); });
        s.once("connect_error", (e) => { clearTimeout(timer); reject(e); });
    });
}

// === OLD: fire-and-forget ===
async function testFireAndForget() {
    let success = 0, fail = 0;
    const errors = new Map();

    for (let i = 0; i < ROUNDS; i++) {
        const sessionId = `faf-${i}`;
        const METHOD = `${sessionId}:echo`;

        const daemon = await connectToServer("session-scoped", { sessionId });
        daemon.on("rpc-request", (data, cb) => cb("pong"));

        // OLD: fire-and-forget
        daemon.emit("rpc-register", { method: METHOD });

        // Caller connects and fires RPC IMMEDIATELY
        const caller = await connectToServer("user-scoped");
        try {
            const result = await caller.timeout(3000).emitWithAck("rpc-call", { method: METHOD, params: "test" });
            if (result.ok) success++;
            else { fail++; errors.set(result.error, (errors.get(result.error) || 0) + 1); }
        } catch (e) {
            fail++; errors.set(e.message, (errors.get(e.message) || 0) + 1);
        }
        daemon.disconnect();
        caller.disconnect();
    }
    return { success, fail, errors, label: "fire-and-forget (OLD)" };
}

// === NEW: await rpc-registered ack ===
async function testAwaitAck() {
    let success = 0, fail = 0;
    const errors = new Map();

    for (let i = 0; i < ROUNDS; i++) {
        const sessionId = `ack-${i}`;
        const METHOD = `${sessionId}:echo`;

        const daemon = await connectToServer("session-scoped", { sessionId });
        daemon.on("rpc-request", (data, cb) => cb("pong"));

        // NEW: await ack
        await new Promise((resolve) => {
            const t = setTimeout(() => resolve(), 5000);
            daemon.once("rpc-registered", () => { clearTimeout(t); resolve(); });
            daemon.emit("rpc-register", { method: METHOD });
        });

        const caller = await connectToServer("user-scoped");
        try {
            const result = await caller.timeout(3000).emitWithAck("rpc-call", { method: METHOD, params: "test" });
            if (result.ok) success++;
            else { fail++; errors.set(result.error, (errors.get(result.error) || 0) + 1); }
        } catch (e) {
            fail++; errors.set(e.message, (errors.get(e.message) || 0) + 1);
        }
        daemon.disconnect();
        caller.disconnect();
    }
    return { success, fail, errors, label: "await-ack (NEW)" };
}

// --- Run both ---
const old = await testFireAndForget();
console.log(`${old.label}:`);
console.log(`  success=${old.success}/${ROUNDS} fail=${old.fail}/${ROUNDS}`);
for (const [err, n] of old.errors) console.log(`  error: "${err}" ×${n}`);

const next = await testAwaitAck();
console.log(`\n${next.label}:`);
console.log(`  success=${next.success}/${ROUNDS} fail=${next.fail}/${ROUNDS}`);
for (const [err, n] of next.errors) console.log(`  error: "${err}" ×${n}`);

console.log("\n" + "=".repeat(50));
if (old.fail > 0 && next.fail === 0) {
    console.log(`✅ PROOF: fire-and-forget fails ${(old.fail/ROUNDS*100).toFixed(0)}%, await-ack fixes it to 0%`);
} else if (old.fail > next.fail) {
    console.log(`✅ IMPROVEMENT: ${(old.fail/ROUNDS*100).toFixed(0)}% → ${(next.fail/ROUNDS*100).toFixed(0)}%`);
} else {
    console.log("⚠️  No difference observed — try increasing JOIN_DELAY_MS");
}

ioServer.close();
httpServer.close();
process.exit(old.fail > 0 && next.fail === 0 ? 0 : 1);
