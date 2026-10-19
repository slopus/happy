import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import environmentHelpers from "../../../../../environments/environments.ts";
const { createEnvironment, getEnvironmentConfig, setEnvironmentTemplate, startEnvironmentServices, seedEnvironment, startEnvironmentWeb, stopEnvironment, removeEnvironment } = environmentHelpers;
import { encodeBase64, encryptLegacy, decryptLegacy } from "../../../../happy-cli/src/api/encryption.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const artifacts = path.join(root, "packages/happy-app/test-results/message-annotations");
fs.mkdirSync(artifacts, { recursive: true });
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1';
const originalLog = console.log;
console.log = (...args) => originalLog(...args.map((value) => typeof value === "string" && value.includes("Auth URL:") ? "Auth URL: \u5DF2\u751F\u6210\uFF08\u51ED\u8BC1\u4E0D\u8F93\u51FA\uFF09" : value));
let environment;
let controller;
const sockets = [];
async function main() {
  environment = await createEnvironment({ noSwitch: true });
  fs.writeFileSync(path.join(artifacts, "environment-name.txt"), environment);
  setEnvironmentTemplate(environment, "authenticated-empty");
  await startEnvironmentServices(environment, { startWeb: false, waitForWebBundle: true });
  await seedEnvironment(environment, { startDaemon: false });
  const config = getEnvironmentConfig(environment);
  const auth = JSON.parse(fs.readFileSync(path.join(root, "environments/data/envs", environment, "cli/home/access.key"), "utf8"));
  const key = new Uint8Array(Buffer.from(auth.secret, "base64"));
  const serverUrl = `http://localhost:${config.serverPort}`;
  const headers = { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" };
  const require2 = createRequire(path.join(root, "packages/happy-cli/package.json"));
  const { io } = require2("socket.io-client");
  const sessionIds = [];
  const live = /* @__PURE__ */ new Map();
  const markdown = `## \u5148\u628A\u4E09\u4E2A\u6982\u5FF5\u5206\u6E05\u695A

\u5E94\u7528**\u7248\u672C**\u63CF\u8FF0\u5F53\u524D\u8FD0\u884C\u7684\u662F\u54EA\u4E00\u4EFD\u4EE3\u7801\u3002\u76F8\u540C\u7248\u672C\u4E5F\u53EF\u4EE5\u8FDE\u63A5\u4E0D\u540C\u7684\u6570\u636E\u670D\u52A1\u3002

\u670D\u52A1\u73AF\u5883\u51B3\u5B9A\u8BF7\u6C42\u53D1\u5F80\u54EA\u4E2A \`API\`\u3002\u5207\u6362\u73AF\u5883\u65F6\uFF0C\u9700\u8981\u6838\u5BF9\u5730\u5740\u548C\u8EAB\u4EFD\u3002

\u6784\u5EFA\u9636\u6BB5\u8BF4\u660E\u4E00\u6B21\u4E1A\u52A1\u6784\u5EFA\u5904\u4E8E\u4EC0\u4E48\u72B6\u6001\uFF0C\u4F8B\u5982\u51C6\u5907\u3001\u9A8C\u8BC1\u6216\u53D1\u5E03\u3002

### \u6392\u67E5\u987A\u5E8F

\u5148\u6838\u5BF9\u8F93\u5165\uFF0C\u518D\u89C2\u5BDF\u8F93\u51FA\u3002

\u5148\u6838\u5BF9\u8F93\u5165\uFF0C\u518D\u89C2\u5BDF\u8F93\u51FA\u3002

\u8FD9\u4E24\u53E5\u76F8\u540C\u539F\u6587\u5C5E\u4E8E\u4E0D\u540C\u4F4D\u7F6E\uFF0C\u53EF\u4EE5\u5206\u522B\u6279\u6CE8\u3002

- \u5148\u8BB0\u5F55\u7248\u672C\uFF0C\u518D\u786E\u8BA4\u5730\u5740\u3002
- \u6700\u540E\u6BD4\u8F83\u9884\u671F\u7ED3\u679C\u548C\u5B9E\u9645\u7ED3\u679C\u3002`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(serverUrl + "/v1/sessions", { method: "POST", headers, body: JSON.stringify({ tag: "annotation-e2e-" + randomUUID(), metadata: encodeBase64(encryptLegacy({ path: "/workspace/annotation-demo", host: "annotation-test.local", name: i ? "\u6279\u6CE8\u4F1A\u8BDD B" : "\u6279\u6CE8\u4F1A\u8BDD A", flavor: "codex", lifecycleState: "running", startedBy: "terminal" }, key)), agentState: encodeBase64(encryptLegacy({ turnStatus: { status: "completed", turnId: "seed-turn", updatedAt: Date.now() } }, key)), dataEncryptionKey: null }) });
    if (!response.ok) throw Error("Could not create isolated session: " + response.status);
    const id = (await response.json()).session.id;
    sessionIds.push(id);
    const envelope = { id: `annotation-demo-reply-${i}`, time: Date.now(), role: "agent", turn: "seed-turn", ev: { t: "text", text: markdown } };
    const append = await fetch(`${serverUrl}/v3/sessions/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ messages: [{ localId: "seed-" + id, content: encodeBase64(encryptLegacy({ role: "session", content: envelope }, key)) }] }) });
    if (!append.ok) throw Error("Could not seed assistant passage: " + append.status);
    const socket = io(serverUrl, { path: "/v1/updates", transports: ["websocket"], reconnection: false, auth: { token: auth.token, clientType: "session-scoped", sessionId: id } });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    live.set(id, socket);
  }
  controller = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const sessionId = url.searchParams.get("session") ?? sessionIds[0];
      if (!sessionIds.includes(sessionId)) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/activate") {
        // A test action advances the synthetic executor's completed-turn ID so
        // the real queue can retire its previous transport barrier. No model runs.
        const current = await fetch(`${serverUrl}/v2/sessions/${sessionId}`, { headers });
        if (!current.ok) throw Error('Session read failed');
        const snapshot = (await current.json()).session;
        const update = await live.get(sessionId).timeout(5000).emitWithAck('update-state', {
          sid: sessionId, expectedVersion: snapshot.agentStateVersion,
          agentState: encodeBase64(encryptLegacy({ turnStatus: { status: 'completed', turnId: 'test-action-' + randomUUID(), updatedAt: Date.now() } }, key))
        });
        if (update.result !== 'success') throw Error('Synthetic executor state update failed');
        live.get(sessionId).emit("session-alive", { sid: sessionId, time: Date.now(), thinking: false });
        response.setHeader("content-type", "application/json");
        response.end('{"active":true}');
        return;
      }
      if (request.method === "GET" && url.pathname === "/messages") {
        const source = await fetch(`${serverUrl}/v3/sessions/${sessionId}/messages?limit=100`, { headers });
        if (!source.ok) throw Error("Message read failed: " + source.status);
        const values = await source.json();
        const messages = values.messages.map((message) => decryptLegacy(new Uint8Array(Buffer.from(message.content.c, "base64")), key));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(messages));
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => controller.listen(0, "127.0.0.1", resolve));
  const address = controller.address();
  if (!address || typeof address === "string") throw Error("No controller port");
  fs.writeFileSync(path.join(artifacts, "runtime.json"), JSON.stringify({ environment, sessionIds, serverUrl, controllerUrl: `http://127.0.0.1:${address.port}`, webUrl: `http://localhost:${config.expoPort}` }, null, 2));
  await startEnvironmentWeb(environment, { warmBundle: true });
  originalLog(JSON.stringify({ ready: true, environment, webUrl: `http://localhost:${config.expoPort}`, sessionIds, controllerUrl: `http://127.0.0.1:${address.port}` }));
}
let closing = false;
function cleanup(exitCode = 0) {
  if (closing) return;
  closing = true;
  sockets.forEach((s) => s.disconnect());
  controller?.close();
  if (environment) {
    stopEnvironment(environment);
    removeEnvironment(environment);
  }
  process.exit(exitCode);
}
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());
main().catch((error) => {
  console.error(error);
  cleanup(1);
});
