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
    const json = await res.json();
    return json;
}

function redisCli(cmd) {
    return execSync(`kubectl exec happy-redis-0 -- redis-cli ${cmd}`).toString().trim();
}

async function main() {
    const { token, user } = await getToken();
    console.log(`Auth: userId=${user?.id ?? '?'}`);

    const sessionId = `probe-${Date.now()}`;
    const METHOD = `${sessionId}:echo`;

    const daemon = io(SERVER, {
        path: "/v1/updates",
        auth: { token, clientType: "session-scoped", sessionId },
        transports: ["websocket"],
        reconnection: false,
    });

    daemon.on("connect", () => console.log(`daemon connected: ${daemon.id}`));
    daemon.on("rpc-registered", (d) => console.log(`✅ rpc-registered ack: ${JSON.stringify(d)}`));
    daemon.on("rpc-error", (d) => console.log(`❌ rpc-error: ${JSON.stringify(d)}`));
    daemon.on("connect_error", (e) => console.log(`connect_error: ${e.message}`));

    await new Promise(r => daemon.on("connect", r));

    // Check redis BEFORE register
    console.log(`\nbefore register: KEYS rpc:* → "${redisCli("KEYS 'rpc:*'")}"`);

    daemon.emit("rpc-register", { method: METHOD });
    console.log(`emitted rpc-register method=${METHOD}`);

    // Wait for ack OR 1s
    await new Promise(r => setTimeout(r, 1000));

    console.log(`\nafter register: KEYS rpc:* → "${redisCli("KEYS 'rpc:*'")}"`);
    const allKeys = redisCli("KEYS '*'");
    console.log(`all redis keys: "${allKeys}"`);

    daemon.disconnect();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
