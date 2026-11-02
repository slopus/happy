// Mock "team server behind an SSO-enforcing load balancer" for the iOS
// simulator run (run-ui-test.sh) and EdgeMockInteropTests. One HTTPS
// listener (PORT, default 8443) and the same on plain HTTP (8444) play
// three parts:
//  - the LB: anything without a valid bearer (except discovery) gets a 302
//    to the IdP; CONNECT is answered 405 text/html (LBs that block CONNECT);
//  - the IdP: /oauth/authorize auto-approves and redirects to the app with a
//    code; /oauth/token issues short-lived access tokens and rotates refresh
//    tokens; requires PKCE and the resource indicator;
//  - the daemon: discovery, health (webSocketTunnels), config, bootstrap,
//    profile gate, SSE with 15 s heartbeats, and WS tunnels that speak an
//    inner HTTP forward proxy answering a fixed page.
// Logs every request (method, path, whether Authorization was present,
// whether the query carried a token) to stdout as JSON lines.
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number(process.env.PORT ?? 8443);
const ORIGIN = `https://localhost:${PORT}`;
const RESOURCE = "https://happy.acme.example";
// The installation's health `instanceId`, which instance links name.
const INSTANCE_ID = "k3x9q2m7p0a4b8c1d5e6f7g2";
const REPORT = "# Q3 report\n\nShipped behind the SSO load balancer.\n";
const ACCESS_TTL = Number(process.env.ACCESS_TTL ?? 90);
const state = {
    codes: new Map(), // code -> {challenge, redirect, resource}
    access: new Map(), // token -> expiry ms
    refresh: new Set(),
    profileName: process.env.ONBOARDED ? "Steve" : null,
    revokeAll: false,
    // `/control/audience` mints tokens for another server; `/control/split`
    // advertises a token URL on another site than the sign-in page.
    audience: null,
    // Tokens issued, by grant: a relaunch that restores the session
    // refreshes without a new authorization code.
    grants: { authorization_code: 0, refresh_token: 0 },
    log: [],
};

function log(entry) {
    const line = JSON.stringify({ t: Date.now(), ...entry });
    console.log(line);
}

function json(res, status, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": data.length, ...headers });
    res.end(data);
}

function bearer(req) {
    const value = req.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(value);
    if (!match) return null;
    const expiry = state.access.get(match[1]);
    if (!expiry || expiry < Date.now() || state.revokeAll) return null;
    return match[1];
}

function b64url(buffer) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
}

// Access tokens are JWTs whose `aud` is the server's public base URL, as
// `[feature.team.jwt] audience` makes the daemon require; unsigned here.
const AUDIENCE = process.env.AUDIENCE ?? `${ORIGIN}/`;
function jwt(aud) {
    const part = (value) => b64url(Buffer.from(JSON.stringify(value)));
    return `${part({ alg: "RS256", typ: "JWT" })}.${part({ aud, sub: "steve", jti: b64url(crypto.randomBytes(12)) })}.${b64url(crypto.randomBytes(32))}`;
}

function issue() {
    const access = jwt(state.audience ?? AUDIENCE);
    const refresh = b64url(crypto.randomBytes(24));
    state.access.set(access, Date.now() + ACCESS_TTL * 1000);
    state.refresh.add(refresh);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh };
}

const method = {
    type: "oauth", id: "jwt", name: "Acme SSO",
    authorizationUrl: `${ORIGIN}/oauth/authorize`, tokenUrl: `${ORIGIN}/oauth/token`, refreshUrl: `${ORIGIN}/oauth/token`,
    clientId: "happy", scope: "happy offline_access", resource: RESOURCE,
};

const bootstrap = () => ({
    cursor: "cursor-1",
    profile: { userId: "steve", name: state.profileName ?? "", photo: null },
    userSettings: [],
    projects: [{ id: "p", name: "acme-web", status: "active", orderKey: "a", agents: [] }],
    workspaces: [],
    bots: [{ id: "research", name: "Research", status: "active", agent: { id: "research-agent", workspaceId: "r", status: "idle" } }],
    tasks: [{ id: "t1", name: "Behind the SSO load balancer", ownerUserId: "steve", agent: { id: "t1-agent", workspaceId: "w1", status: "idle" } }],
    taskMemberships: [{ taskId: "t1" }],
    surfaces: [],
});

const options = { key: fs.readFileSync(new URL("./server.key", import.meta.url)), cert: fs.readFileSync(new URL("./server.crt", import.meta.url)) };
const handler = async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    const queryToken = [...url.searchParams.keys()].some((k) => /token|access|bearer/i.test(k));
    log({ method: req.method, path: url.pathname, auth: Boolean(req.headers.authorization), queryToken });

    // IdP
    if (url.pathname === "/oauth/authorize") {
        const p = url.searchParams;
        if (p.get("response_type") !== "code" || p.get("client_id") !== "happy" || p.get("code_challenge_method") !== "S256" || p.get("resource") !== RESOURCE || p.get("redirect_uri") !== "happy://oauth/callback") {
            return json(res, 400, { error: "invalid_request" });
        }
        const code = b64url(crypto.randomBytes(16));
        state.codes.set(code, { challenge: p.get("code_challenge"), redirect: p.get("redirect_uri"), resource: p.get("resource") });
        const target = `${p.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(p.get("state"))}`;
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body style="font:20px -apple-system;padding:40px"><h2>Acme SSO</h2><p>Signed in as steve@acme.example</p><a id="go" href="${target}" style="font-size:28px">Continue to Happy</a></body></html>`);
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        log({ token: form.get("grant_type"), resource: form.get("resource"), client: form.get("client_id") });
        if (form.get("client_id") !== "happy" || form.get("resource") !== RESOURCE) return json(res, 400, { error: "invalid_target" });
        if (form.get("grant_type") === "authorization_code") {
            const entry = state.codes.get(form.get("code"));
            state.codes.delete(form.get("code"));
            const verifier = form.get("code_verifier") ?? "";
            if (!entry || entry.redirect !== form.get("redirect_uri") || b64url(crypto.createHash("sha256").update(verifier).digest()) !== entry.challenge) {
                return json(res, 400, { error: "invalid_grant" });
            }
            state.grants.authorization_code++;
            return json(res, 200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
            const token = form.get("refresh_token");
            if (state.revokeAll || !state.refresh.has(token)) return json(res, 400, { error: "invalid_grant", error_description: "The session ended." });
            state.refresh.delete(token);
            state.grants.refresh_token++;
            return json(res, 200, issue());
        }
        return json(res, 400, { error: "unsupported_grant_type" });
    }

    // Test controls (loopback only, no auth): expire tokens / end the SSO session.
    if (url.pathname === "/control/expire") { state.access.clear(); return json(res, 200, { ok: true }); }
    if (url.pathname === "/control/revoke") { state.revokeAll = true; return json(res, 200, { ok: true }); }
    if (url.pathname === "/control/restore") { state.revokeAll = false; return json(res, 200, { ok: true }); }
    if (url.pathname === "/control/log") return json(res, 200, { ok: true });
    if (url.pathname === "/control/grants") return json(res, 200, state.grants);
    if (url.pathname === "/control/audience") { state.audience = url.searchParams.get("aud"); return json(res, 200, { ok: true }); }
    if (url.pathname === "/control/split") { method.tokenUrl = `https://127.0.0.1:${PORT}/oauth/token`; return json(res, 200, { ok: true }); }
    if (url.pathname === "/control/bind") { method.tokenUrl = `${ORIGIN}/oauth/token`; return json(res, 200, { ok: true }); }

    // Discovery: forwarded without edge auth.
    if (url.pathname === "/v0/authentication") {
        const token = bearer(req);
        return json(res, 200, { authenticated: Boolean(token), userId: token && state.profileName ? "steve" : null, methods: [method] });
    }

    // The LB: no credential at all goes to the IdP's login page.
    if (!req.headers.authorization || state.revokeAll) {
        res.writeHead(302, { location: `${ORIGIN}/oauth/authorize?client_id=edge`, "content-type": "text/html" });
        return res.end("<html>Redirecting to SSO</html>");
    }
    // The daemon: an expired or unknown token is its 401 with the methods.
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "Unauthorized", code: "unauthorized", authentication: { methods: [method] } });

    // The daemon.
    if (url.pathname === "/v0/health") return json(res, 200, { ready: true, version: { protocol: 33, daemon: "mock" }, capabilities: { webSocketTunnels: true }, instanceId: INSTANCE_ID });
    if (url.pathname === "/v0/profile" && req.method === "GET") return json(res, 200, { profile: { userId: state.profileName ? "steve" : null, name: state.profileName, email: null, photo: null, version: "v1", updatedAt: 1 } });
    if (url.pathname === "/v0/profile" && req.method === "PATCH") {
        const body = JSON.parse(await readBody(req) || "{}");
        state.profileName = body.name;
        return json(res, 200, { profile: { userId: "steve", name: state.profileName, email: null, photo: null, version: "v2", updatedAt: 2 } });
    }
    // The profile gate, as API.md describes it.
    if (!state.profileName && !["/v0/onboarding"].includes(url.pathname)) return json(res, 401, { error: "Unauthorized", code: "unauthorized" });
    if (url.pathname === "/v0/config") return json(res, 200, { config: { node: { name: "Acme Team Server" } } });
    if (url.pathname === "/v0/bootstrap/desktop") return json(res, 200, bootstrap());
    if (url.pathname === "/v0/events/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: hello\ndata: ${JSON.stringify({ cursor: "cursor-1", resumed: Boolean(req.headers["last-event-id"]), daemonId: "mock" })}\n\n`);
        const timer = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15000);
        req.on("close", () => clearInterval(timer));
        return;
    }
    if (url.pathname.startsWith("/v0/users")) return json(res, 200, { users: [] });
    // One artifact, for instance links.
    if (url.pathname === "/v0/artifacts/q3report/versions/latest" || url.pathname === "/v0/artifacts/q3report/versions/1") {
        const entry = { path: "index.md", mimeType: "text/markdown", size: Buffer.byteLength(REPORT) };
        return json(res, 200, { version: { artifactId: "q3report", number: 1, title: "Q3 report", entry, files: [entry] } });
    }
    if (url.pathname === "/v0/artifacts/q3report/versions/1/files/index.md") {
        res.writeHead(200, { "content-type": "text/markdown", "content-length": Buffer.byteLength(REPORT) });
        return res.end(REPORT);
    }
    return json(res, 404, { error: "Not found", code: "not_found" });
};
const server = https.createServer(options, handler);

// The LB blocks CONNECT.
const onConnect = (req, socket) => {
    log({ method: "CONNECT", path: req.url, auth: Boolean(req.headers.authorization) });
    socket.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-type: text/html\r\ncontent-length: 20\r\n\r\n<html>blocked</html>");
};

// WebSocket tunnels: one WS = one CONNECT tunnel to an inner forward proxy.
const onUpgrade = (req, socket) => {
    const url = new URL(req.url, ORIGIN);
    const ok = bearer(req);
    log({ method: "UPGRADE", path: url.pathname, auth: Boolean(req.headers.authorization) });
    if (!ok) { socket.end("HTTP/1.1 302 Found\r\nlocation: https://idp.example\r\ncontent-length: 0\r\n\r\n"); return; }
    if (!/\/proxy\/websocket$/.test(url.pathname)) { socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    let inner = "";
    const send = (opcode, payload) => {
        const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
        socket.write(Buffer.concat([header, payload]));
    };
    const ping = setInterval(() => send(0x9, Buffer.from("k")), 15000);
    socket.on("close", () => clearInterval(ping));
    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
            const opcode = buffer[0] & 15;
            let length = buffer[1] & 127, offset = 2;
            if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i & 3]));
            buffer = buffer.subarray(offset + 4 + length);
            if (opcode === 0x8) { send(0x8, Buffer.from([3, 232])); socket.end(); return; }
            if (opcode === 0x9) { send(0xa, payload); continue; }
            if (opcode !== 0x2 && opcode !== 0x0) { send(0x8, Buffer.from([3, 235])); socket.end(); return; }
            inner += payload.toString();
            if (inner.includes("\r\n\r\n")) {
                const line = inner.split("\r\n")[0];
                log({ tunnel: line });
                const page = `<html><body style="font:22px -apple-system;padding:30px"><h2>Preview over a WebSocket tunnel</h2><p>${line}</p></body></html>`;
                send(0x2, Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(page)}\r\nconnection: close\r\n\r\n${page}`));
                send(0x2, Buffer.alloc(0));
                inner = "";
            }
        }
    });
};

server.on("connect", onConnect);
server.on("upgrade", onUpgrade);
server.listen(PORT, "127.0.0.1", () => log({ listening: ORIGIN }));
// Plain HTTP twin for the WebSocket interop test (no TLS on that path).
const plain = http.createServer(handler);
plain.on("connect", onConnect); plain.on("upgrade", onUpgrade);
plain.listen(PORT + 1, "127.0.0.1", () => log({ listening: `http://127.0.0.1:${PORT + 1}` }));
