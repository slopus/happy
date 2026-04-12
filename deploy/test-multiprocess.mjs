import tweetnacl from "tweetnacl";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import { execSync } from "child_process";

const SERVER = "http://127.0.0.1:3000"; // minikube tunnel LB
const NUM_CLIENTS = 20;

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

function findSocketInPodLogs(socketId, pods) {
  for (const pod of pods) {
    const logs = execSync(`kubectl logs ${pod} --tail=200 2>/dev/null`).toString();
    if (logs.includes(socketId)) return pod;
  }
  return "unknown";
}

async function test() {
  console.log("=== RECONNECTION TEST via LoadBalancer ===");
  console.log(`Server: ${SERVER} (minikube tunnel)\n`);

  const health = await fetch(`${SERVER}/health`).then(r => r.json());
  console.log(`Health: ${health.status}`);

  const pods = getPods();
  console.log(`Pods: ${pods.join(", ")}\n`);

  const token = await getToken();

  // ============================================================
  // Connect ALL clients through the LB — no pod targeting
  // k8s distributes them naturally
  // ============================================================
  console.log(`--- Connecting ${NUM_CLIENTS} clients through LoadBalancer ---`);
  console.log(`Reconnection: enabled (500ms delay, 20 attempts)\n`);

  const clients = [];
  for (let i = 0; i < NUM_CLIENTS; i++) {
    const socket = io(SERVER, {
      path: "/v1/updates",
      auth: { token, clientType: "user-scoped" },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      reconnectionAttempts: 20,
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Client ${i}: timeout`)), 10000);
      socket.on("connect", () => { clearTimeout(timeout); resolve(); });
      socket.on("connect_error", (err) => { clearTimeout(timeout); reject(err); });
    });

    clients.push({
      socket,
      originalId: socket.id,
      disconnectTime: null,
      reconnectTime: null,
      disconnected: false,
      reconnected: false,
      reconnectAttempt: 0,
      pod: null,
    });
  }
  console.log(`  ${NUM_CLIENTS} clients connected.\n`);

  // Check pod distribution from logs
  await new Promise(r => setTimeout(r, 2000));

  const podDist = {};
  for (const pod of pods) podDist[pod] = 0;

  for (const client of clients) {
    const pod = findSocketInPodLogs(client.originalId, pods);
    client.pod = pod;
    if (podDist[pod] !== undefined) podDist[pod]++;
    else podDist[pod] = 1;
  }

  console.log("  Pod distribution:");
  for (const [pod, count] of Object.entries(podDist)) {
    console.log(`    ${pod}: ${count} clients`);
  }

  // Kill the pod with more clients
  const podToKill = Object.entries(podDist).sort((a, b) => b[1] - a[1])[0][0];
  const affectedCount = podDist[podToKill];
  console.log(`\n  Will kill: ${podToKill} (${affectedCount} clients affected)\n`);

  // ============================================================
  // Track disconnect + reconnect
  // ============================================================
  for (const client of clients) {
    client.socket.on("disconnect", (reason) => {
      if (!client.disconnectTime) {
        client.disconnectTime = Date.now();
        client.disconnected = true;
        client.disconnectReason = reason;
      }
    });
    client.socket.on("reconnect", (attempt) => {
      client.reconnectTime = Date.now();
      client.reconnected = true;
      client.reconnectAttempt = attempt;
    });
    client.socket.on("reconnect_failed", () => {
      client.reconnectFailed = true;
    });
  }

  // ============================================================
  // KILL
  // ============================================================
  console.log("--- KILLING POD ---");
  const killTime = Date.now();
  execSync(`kubectl delete pod ${podToKill} --grace-period=0 --force 2>/dev/null || true`);
  console.log(`  ${podToKill} killed.\n`);

  for (let sec = 1; sec <= 30; sec++) {
    await new Promise(r => setTimeout(r, 1000));

    const disconnected = clients.filter(c => c.disconnected).length;
    const reconnected = clients.filter(c => c.reconnected).length;
    const failed = clients.filter(c => c.reconnectFailed).length;
    const connected = clients.filter(c => c.socket.connected).length;

    console.log(
      `  t+${sec.toString().padStart(2)}s:  connected=${connected}/${NUM_CLIENTS}  disconnected=${disconnected}  reconnected=${reconnected}  failed=${failed}`
    );

    if (connected >= NUM_CLIENTS || (reconnected + failed >= affectedCount && sec > 3)) {
      console.log(`  Settled.`);
      break;
    }
  }

  // ============================================================
  // RESULTS
  // ============================================================
  console.log("\n--- RESULTS ---\n");

  const affected = clients.filter(c => c.pod === podToKill);
  const unaffected = clients.filter(c => c.pod !== podToKill);

  // Affected
  const affDisc = affected.filter(c => c.disconnected);
  const affRecon = affected.filter(c => c.reconnected);

  console.log(`Affected clients (on killed pod): ${affected.length}`);
  if (affDisc.length > 0) {
    const dt = affDisc.map(c => c.disconnectTime - killTime);
    console.log(`  Disconnect:    ${affDisc.length}/${affected.length} detected in avg ${Math.round(dt.reduce((a, b) => a + b, 0) / dt.length)}ms`);
  }
  if (affRecon.length > 0) {
    const rt = affRecon.map(c => c.reconnectTime - killTime);
    const down = affRecon.map(c => c.reconnectTime - c.disconnectTime);
    console.log(`  Reconnected:   ${affRecon.length}/${affected.length} via LB auto-failover`);
    console.log(`  Reconnect at:  avg ${Math.round(rt.reduce((a, b) => a + b, 0) / rt.length)}ms from kill`);
    console.log(`  User downtime: avg ${Math.round(down.reduce((a, b) => a + b, 0) / down.length)}ms`);
    console.log(`  Attempts:      ${affRecon.map(c => c.reconnectAttempt).join(", ")}`);
  }

  // Unaffected
  const unaffDisc = unaffected.filter(c => c.disconnected);
  console.log(`\nUnaffected clients (surviving pod): ${unaffected.length}`);
  console.log(`  Disrupted: ${unaffDisc.length} (should be 0)`);
  console.log(`  Connected: ${unaffected.filter(c => c.socket.connected).length}`);

  // Verify events work after recovery
  console.log("\nVerifying events post-recovery...");
  let eventCount = 0;
  const connected = clients.filter(c => c.socket.connected);
  for (const c of connected) {
    c.socket.removeAllListeners("update");
    c.socket.on("update", () => eventCount++);
  }

  await fetch(`${SERVER}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tag: `post-kill-${Date.now()}`, metadata: "{}" }),
  });
  await new Promise(r => setTimeout(r, 2000));

  console.log(`  Connected: ${connected.length}/${NUM_CLIENTS}`);
  console.log(`  Events:    ${eventCount}/${connected.length}`);

  // ============================================================
  console.log("\n========================================");
  console.log("           VERDICT");
  console.log("========================================");
  console.log(`Pod distribution:    ${Object.entries(podDist).map(([p, c]) => `${c}`).join(" / ")}`);
  if (affDisc.length > 0) {
    const dt = affDisc.map(c => c.disconnectTime - killTime);
    console.log(`Disconnect speed:    ${Math.round(dt.reduce((a, b) => a + b, 0) / dt.length)}ms`);
  }
  if (affRecon.length > 0) {
    const down = affRecon.map(c => c.reconnectTime - c.disconnectTime);
    console.log(`Auto-reconnect:      ${affRecon.length}/${affected.length} clients`);
    console.log(`User downtime:       ${Math.round(down.reduce((a, b) => a + b, 0) / down.length)}ms avg`);
  }
  console.log(`Surviving clients:   ${unaffected.filter(c => c.socket.connected).length}/${unaffected.length} unaffected`);
  console.log(`Post-kill events:    ${eventCount}/${connected.length}`);

  for (const c of clients) c.socket.disconnect();
  process.exit(0);
}

test().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
