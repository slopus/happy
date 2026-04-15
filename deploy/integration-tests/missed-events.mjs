// Definitive test of message-propagation across reconnect.
//
// Scenario:
//   1. Connect a user-scoped socket (the "watcher") and capture every `update`
//      event it receives.
//   2. Trigger a server-side broadcast by POSTing /v1/sessions — server emits
//      'new-session' update to the user-scoped room.
//   3. Verify the watcher received it.
//   4. Disconnect the watcher.
//   5. Trigger another /v1/sessions POST while the watcher is offline.
//   6. Reconnect the watcher.
//   7. Wait briefly. Did the missed event arrive?
//   8. Also: hit GET /v1/sessions to confirm the second session exists in DB
//      (the client's fall-back re-fetch path).
//
// EXPECTED with current config (no connectionStateRecovery):
//   - Step 3 watcher receives event #1 ✅
//   - Step 7 watcher receives ZERO new events (the missed broadcast is lost)
//   - Step 8 GET returns BOTH sessions (DB has them) ✅
//
// This proves: broadcasts are LOST during disconnect, and the client must
// re-fetch on reconnect to catch up. Same as origin/main, same as the broken
// multi-replica code, same as the fix.

import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";

const SERVER = process.env.SERVER ?? "http://127.0.0.1:3000";
const base64 = (b) => Buffer.from(b).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s] ${m}`);

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

async function createSession(token, tag) {
    const r = await fetch(`${SERVER}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ tag, metadata: JSON.stringify({ tag }) }),
    });
    if (!r.ok) throw new Error(`createSession ${r.status} ${await r.text()}`);
    return (await r.json()).session;
}

async function listSessions(token) {
    const r = await fetch(`${SERVER}/v1/sessions`, {
        headers: { "Authorization": `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`listSessions ${r.status}`);
    return (await r.json()).sessions;
}

function connectWatcher(token) {
    const events = [];
    const socket = io(SERVER, {
        path: "/v1/updates",
        auth: { token, clientType: "user-scoped" },
        transports: ["websocket"],
        // Auto-reconnect MUST be enabled for connectionStateRecovery to work.
        // Recovery only fires when the socket reconnects through the engine's
        // own auto-reconnect path (not from a manual disconnect+connect).
        // Delay set to 1500ms so we have a clean window to fire the missed
        // event AFTER the disconnect but BEFORE auto-reconnect completes.
        reconnection: true,
        reconnectionDelay: 1500,
        reconnectionDelayMax: 1500,
    });
    socket.on("update", (data) => {
        const t = data?.body?.t ?? "?";
        events.push({ t, body: data?.body });
    });
    socket.on("connect", () => {
        log(`  watcher connected as ${socket.id}, recovered=${socket.recovered}`);
    });
    socket.on("disconnect", (reason) => {
        log(`  watcher disconnect: ${reason}`);
    });
    return { socket, events };
}

async function main() {
    const token = await getToken();
    log("auth ok");

    const { socket: watcher, events } = connectWatcher(token);
    await new Promise((r) => watcher.once("connect", r));

    // === STEP 1+2: trigger event #1 while watcher is connected ===
    const tag1 = `test-${Date.now()}-A`;
    log(`creating session #1 (tag=${tag1})`);
    const s1 = await createSession(token, tag1);
    log(`  session #1 id=${s1.id}`);
    await sleep(500);  // give the broadcast a moment

    // === STEP 3: did the watcher receive it? ===
    const newSessionEvents1 = events.filter(e => e.t === "new-session");
    log(`  watcher received ${newSessionEvents1.length} new-session events`);
    log(`  ✅ event #1 received: ${newSessionEvents1.some(e => e.body.id === s1.id) ? "YES" : "NO"}`);

    // === STEP 4: force a TRANSPORT-LEVEL disconnect (not graceful), so the
    // engine's auto-reconnect path runs — that path sends the recovery
    // handshake. A manual socket.disconnect() would NOT trigger recovery. ===
    log("force-closing watcher transport (engine.close)");
    const eventsBefore = events.length;
    const oldSid = watcher.id;
    watcher.io.engine.close();
    await sleep(200);

    // === STEP 5: trigger event #2 while watcher offline ===
    const tag2 = `test-${Date.now()}-B`;
    log(`creating session #2 (tag=${tag2}) — watcher OFFLINE`);
    const s2 = await createSession(token, tag2);
    log(`  session #2 id=${s2.id}`);

    // === STEP 6: wait for auto-reconnect ===
    log("waiting for auto-reconnect");
    if (!watcher.connected) {
        await new Promise((r) => watcher.once("connect", r));
    }
    log(`  reconnected, new sid=${watcher.id} (was ${oldSid}), recovered=${watcher.recovered}`);
    await sleep(1500);  // give server time to push any replayed events

    // === STEP 7: did missed event arrive? ===
    const newEvents = events.slice(eventsBefore);
    const missedReceived = newEvents.some(e => e.t === "new-session" && e.body.id === s2.id);
    log(`  events received after reconnect: ${newEvents.length}`);
    log(`  missed-event #2 replayed via socket: ${missedReceived ? "YES (state recovery worked)" : "NO (lost; client must re-fetch)"}`);

    // === STEP 8: REST fall-back ===
    const allSessions = await listSessions(token);
    const inDb1 = allSessions.find(s => s.id === s1.id);
    const inDb2 = allSessions.find(s => s.id === s2.id);
    log(`  REST GET /v1/sessions returns ${allSessions.length} sessions`);
    log(`  session #1 in DB: ${inDb1 ? "YES" : "NO"}`);
    log(`  session #2 in DB: ${inDb2 ? "YES" : "NO"}`);

    log("");
    log("=== SUMMARY ===");
    log(`event #1 (online):  watcher received: ${newSessionEvents1.some(e => e.body.id === s1.id) ? "YES ✅" : "NO ❌"}`);
    log(`event #2 (offline): watcher received via socket on reconnect: ${missedReceived ? "YES (recovery)" : "NO (lost from stream)"}`);
    log(`event #2 in DB:     ${inDb2 ? "YES (REST re-fetch path works)" : "NO ❌"}`);
    log(`socket.recovered on reconnect: ${watcher.recovered}`);

    watcher.disconnect();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
