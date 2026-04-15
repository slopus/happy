import { io, Socket } from "socket.io-client";
import * as privacyKit from "privacy-kit";

const MASTER_SECRET = "local-dev-secret-not-for-production";
const POD_A = "http://localhost:3005";
const POD_B = "http://localhost:3006";
const SOCKET_PATH = "/v1/updates";

async function createToken(userId: string): Promise<string> {
    const generator = await privacyKit.createPersistentTokenGenerator({
        service: "handy",
        seed: MASTER_SECRET,
    });
    return await generator.new({ user: userId });
}

function connect(
    url: string,
    token: string,
    label: string,
    opts: { clientType?: string; sessionId?: string; machineId?: string } = {}
): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = io(url, {
            path: SOCKET_PATH,
            transports: ["websocket"],
            auth: {
                token,
                clientType: opts.clientType || "user-scoped",
                sessionId: opts.sessionId,
                machineId: opts.machineId,
            },
        });

        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error(`${label}: connection timeout`));
        }, 10000);

        socket.on("connect", () => {
            clearTimeout(timeout);
            console.log(`  [${label}] connected (${socket.id})`);
            resolve(socket);
        });

        socket.on("connect_error", (err) => {
            clearTimeout(timeout);
            reject(new Error(`${label}: ${err.message}`));
        });
    });
}

// Test 1: A machine-scoped client connecting triggers a "machine-activity" ephemeral
// with recipientFilter "user-scoped-only". Both user-scoped clients (on different pods)
// should receive it via Redis adapter broadcast.
async function testCrossProcessBroadcast(): Promise<boolean> {
    console.log("\n--- Test 1: Cross-process ephemeral broadcast ---");

    const token = await createToken("test-user-broadcast");

    const clientA = await connect(POD_A, token, "Pod A / user-scoped");
    const clientB = await connect(POD_B, token, "Pod B / user-scoped");

    const received = { a: false, b: false };

    const done = new Promise<void>((resolve) => {
        const check = () => { if (received.a && received.b) resolve(); };

        clientA.on("ephemeral", (data: any) => {
            console.log(`  [Pod A] ephemeral: ${JSON.stringify(data)}`);
            received.a = true;
            check();
        });

        clientB.on("ephemeral", (data: any) => {
            console.log(`  [Pod B] ephemeral: ${JSON.stringify(data)}`);
            received.b = true;
            check();
        });
    });

    // Give clients a moment to fully register rooms
    await sleep(500);

    // Connecting a machine-scoped client triggers machine-activity ephemeral to user-scoped clients
    console.log("  Connecting machine client to Pod A to trigger broadcast...");
    const machine = await connect(POD_A, token, "Pod A / machine", {
        clientType: "machine-scoped",
        machineId: "test-machine-1",
    });

    const result = await race(done, 5000);

    machine.disconnect();
    clientA.disconnect();
    clientB.disconnect();

    if (result === "ok") {
        console.log("  PASS: Both pods received the ephemeral event");
        return true;
    } else {
        console.log(`  FAIL: a=${received.a}, b=${received.b} (expected both true)`);
        return false;
    }
}

// Test 2: Session-scoped client should NOT receive "user-scoped-only" events
async function testRoomIsolation(): Promise<boolean> {
    console.log("\n--- Test 2: Room isolation (session-scoped excluded from user-scoped-only) ---");

    const token = await createToken("test-user-isolation");

    const userClient = await connect(POD_A, token, "Pod A / user-scoped");
    const sessionClient = await connect(POD_B, token, "Pod B / session-scoped", {
        clientType: "session-scoped",
        sessionId: "test-session-1",
    });

    let userGot = false;
    let sessionGot = false;

    userClient.on("ephemeral", () => { userGot = true; });
    sessionClient.on("ephemeral", () => { sessionGot = true; });

    await sleep(500);

    const machine = await connect(POD_A, token, "Pod A / machine-iso", {
        clientType: "machine-scoped",
        machineId: "test-machine-iso",
    });

    await sleep(3000);

    machine.disconnect();
    userClient.disconnect();
    sessionClient.disconnect();

    if (userGot && !sessionGot) {
        console.log("  PASS: user-scoped got event, session-scoped did not");
        return true;
    } else {
        console.log(`  FAIL: user=${userGot}, session=${sessionGot} (expected true, false)`);
        return false;
    }
}

// Test 3: Machine disconnect triggers offline ephemeral across pods
async function testDisconnectBroadcast(): Promise<boolean> {
    console.log("\n--- Test 3: Machine disconnect broadcasts across pods ---");

    const token = await createToken("test-user-disconnect");

    const userClient = await connect(POD_B, token, "Pod B / user-scoped");

    let offlineReceived = false;

    userClient.on("ephemeral", (data: any) => {
        if (data.type === "machine-activity" && data.active === false) {
            console.log(`  [Pod B] received offline event: ${JSON.stringify(data)}`);
            offlineReceived = true;
        }
    });

    await sleep(500);

    const machine = await connect(POD_A, token, "Pod A / machine-dc", {
        clientType: "machine-scoped",
        machineId: "test-machine-dc",
    });

    await sleep(500);

    // Disconnect the machine — should broadcast offline to user-scoped on Pod B
    console.log("  Disconnecting machine client...");
    machine.disconnect();

    await sleep(2000);

    userClient.disconnect();

    if (offlineReceived) {
        console.log("  PASS: Offline event received across pods");
        return true;
    } else {
        console.log("  FAIL: No offline event received");
        return false;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function race(promise: Promise<void>, ms: number): Promise<"ok" | "timeout"> {
    return Promise.race([
        promise.then(() => "ok" as const),
        sleep(ms).then(() => "timeout" as const),
    ]);
}

async function main() {
    console.log("=== Multi-Process Socket.IO Test ===");
    console.log(`Pod A: ${POD_A} | Pod B: ${POD_B}\n`);

    // Verify both pods are reachable
    for (const [label, url] of [["Pod A", POD_A], ["Pod B", POD_B]]) {
        const res = await fetch(`${url}/health`);
        const data = await res.json();
        console.log(`${label} health: ${JSON.stringify(data)}`);
    }

    let passed = 0;
    const tests = [testCrossProcessBroadcast, testRoomIsolation, testDisconnectBroadcast];

    for (const test of tests) {
        try {
            if (await test()) passed++;
        } catch (e: any) {
            console.log(`  ERROR: ${e.message}`);
        }
    }

    console.log(`\n=== Results: ${passed}/${tests.length} passed ===`);
    process.exit(passed === tests.length ? 0 : 1);
}

main();
