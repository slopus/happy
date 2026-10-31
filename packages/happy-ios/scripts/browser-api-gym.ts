// Run with Bun and HAPPY_AGENT_REPO pointing at a happy-agent checkout with
// dependencies installed and its modules/daemon packages built. Uses the real
// daemon, routes, database and browser SDK.
// Only inference/compute are substituted by the daemon's black-box gym.
import { createConnection, createServer } from "node:net";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const repo = process.env.HAPPY_AGENT_REPO;
if (!repo) throw new Error("Set HAPPY_AGENT_REPO to the daemon checkout");
const root = resolve(import.meta.dirname, "../../..");
process.env.HAPPY_AGENT_GYM_SCRATCH_DIRECTORY = resolve(root, ".context");
const { createAgentGym } = await import(resolve(repo, "packages/happy-agent-gym/sources/createAgentGym.ts"));
const gym = await createAgentGym({ timeoutMs: 30000 });
// Byte-transparent TCP -> Unix adapter: no HTTP parsing, status rewriting,
// authentication substitution or fake API behavior between iOS and the daemon.
const sockets = new Set<ReturnType<typeof createConnection>>();
const server = createServer((local) => {
    const remote = createConnection(gym.socketPath);
    sockets.add(local); sockets.add(remote);
    local.pipe(remote); remote.pipe(local);
    local.on("error", () => remote.destroy());
    remote.on("error", () => local.destroy());
    local.on("close", () => { sockets.delete(local); remote.destroy(); });
    remote.on("close", () => { sockets.delete(remote); local.destroy(); });
});
const configuration = resolve(root, ".context/browser-api-gym.json");
let published = false;
let stop: () => void = () => {};
const stopped = new Promise<void>((done) => { stop = done; });
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
    const script = await readFile(resolve(import.meta.dirname, "../Tests/HappyUIKitHostedTests/Fixtures/browser-api-regression.js"), "utf8");
    const { artifact } = await gym.client.createArtifact({
        type: "html", title: "iOS browser API regression",
        files: [
            { path: "index.html", text: '<!doctype html><meta name="viewport" content="width=device-width"><script src="/api/v1/client.js"></script><pre id="result">Starting</pre><script src="regression.js"></script>' },
            { path: "regression.js", text: script },
        ],
    });
    await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    await writeFile(configuration, JSON.stringify({ port: address.port, token: gym.token, artifactID: artifact.id }), { mode: 0o600, flag: "wx" });
    published = true;
    console.log(`Real daemon API fixture ready on port ${address.port}; artifact ${artifact.id}`);
    await stopped;
} finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    server.close();
    for (const socket of sockets) socket.destroy();
    if (published) await unlink(configuration).catch(() => {});
    await gym.dispose();
}