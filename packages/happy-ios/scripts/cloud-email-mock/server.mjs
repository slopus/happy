// A stand-in for Happy Cloud's accounts service and the cluster's API at
// once, for email sign-in on a phone or simulator (CloudEmailSignInUITests,
// with the harness's `-cloudAccounts http://<this Mac>:8790`, which sends
// both there). Plain HTTP on PORT (default 8790) and HOST (default every
// interface). It plays happy-accounts' email routes, the API's session and
// the servers list:
//  - POST /v2/auth/email/start {email}: 202 {}. An address without `@` is
//    400 invalid_email; `…@unsupported.test` 400 unsupported_provider (email
//    sign-in not configured); `…@down.test` 502 unavailable; `limit…` or a
//    fourth code within a minute 429 rate_limited with Retry-After.
//  - POST /v2/auth/email/verify {email, code}: CODE (default 123456) answers
//    an identity token (an unsigned JWT for the client `happy`, five
//    minutes); anything else 400 invalid_code, and a third wrong code in a
//    row 429 rate_limited.
//  - POST /v1/session {id_token}: an identity token it issued, once, for
//    the session (an access token for the API, an hour, and a refresh
//    token); anything else 401 invalid_token.
//  - POST /token (refresh_token grant, form) rotates the session; POST
//    /revoke ends it.
//  - GET /v1/servers under the session's access token: two servers.
//  - /v1/auth/*: 410 update_required, as the accounts service answers an
//    earlier build after the split.
//  - POST /control/reset forgets the counts.
// Logs every request as a JSON line. Codes are never emailed.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "0.0.0.0";
const CODE = process.env.CODE ?? "123456";
const ACCOUNTS = "https://auth.happy.engineering";
const API = process.env.API ?? "https://api.happy-clusters.com";
const state = { sent: new Map(), wrong: new Map(), identities: new Map(), tokens: new Set(), refresh: new Map() };

const b64 = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2ln`;
const now = () => Math.floor(Date.now() / 1000);

function identity(email) {
    const token = jwt({ iss: ACCOUNTS, aud: "happy", azp: "happy", sub: email, email, iat: now(), exp: now() + 300, jti: crypto.randomUUID() });
    state.identities.set(token, email);
    return token;
}

function session(email) {
    const access = jwt({ iss: API, aud: `${API}/`, sub: email, iat: now(), exp: now() + 3600, jti: crypto.randomUUID() });
    const refresh = `mock-refresh-${crypto.randomUUID()}`;
    state.tokens.add(access);
    state.refresh.set(refresh, email);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
}

function answer(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
}

function limited(res, retryAfter, error) {
    answer(res, 429, { code: "rate_limited", error, retryAfter }, { "Retry-After": String(retryAfter) });
}

function read(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
            if ((req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return resolve(Object.fromEntries(new URLSearchParams(data)));
            try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://mock").pathname;
    const body = req.method === "POST" ? await read(req) : {};
    console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path, email: body.email, code: body.code, bearer: Boolean(req.headers.authorization) }));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (path.startsWith("/v1/auth/")) {
        return answer(res, 410, { code: "update_required", error: "This version of Happy can't sign in to Happy Cloud any more. Update the app." });
    }
    if (req.method === "POST" && path === "/v2/auth/email/start") {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return answer(res, 400, { code: "invalid_email", error: "Enter a valid email address." });
        if (email.endsWith("@unsupported.test")) return answer(res, 400, { code: "unsupported_provider", error: "Email sign-in is not configured." });
        if (email.endsWith("@down.test")) return answer(res, 502, { code: "unavailable", error: "Couldn't send a code right now. Try again." });
        if (email.startsWith("limit")) return limited(res, 45, "Too many codes requested. Try again later.");
        const recent = (state.sent.get(email) ?? []).filter((at) => Date.now() - at < 60_000);
        if (recent.length >= 3) return limited(res, Math.ceil((60_000 - (Date.now() - recent[0])) / 1000), "Too many codes requested. Try again later.");
        state.sent.set(email, [...recent, Date.now()]);
        state.wrong.delete(email);
        console.log(JSON.stringify({ code: CODE, to: email }));
        return answer(res, 202, {});
    }
    if (req.method === "POST" && path === "/v2/auth/email/verify") {
        if (!email.includes("@")) return answer(res, 400, { code: "invalid_email", error: "Enter a valid email address." });
        if (body.code === CODE) {
            state.wrong.delete(email);
            return answer(res, 200, { id_token: identity(email), expires_in: 300 });
        }
        const wrong = (state.wrong.get(email) ?? 0) + 1;
        state.wrong.set(email, wrong);
        if (wrong >= 3) return limited(res, 30, "Too many wrong codes. Wait a moment and try again.");
        return answer(res, 400, { code: "invalid_code", error: "That code didn't work." });
    }
    if (req.method === "POST" && path === "/v1/session") {
        const who = state.identities.get(body.id_token);
        if (!who) return answer(res, 401, { code: "invalid_token", error: "That sign-in has expired. Sign in again." });
        state.identities.delete(body.id_token);
        return answer(res, 200, session(who));
    }
    if (req.method === "POST" && path === "/token") {
        const who = body.grant_type === "refresh_token" && state.refresh.get(body.refresh_token);
        if (!who) return answer(res, 400, { error: "invalid_grant" });
        state.refresh.delete(body.refresh_token);
        return answer(res, 200, session(who));
    }
    if (req.method === "POST" && path === "/revoke") {
        state.refresh.delete(body.token);
        return answer(res, 200, {});
    }
    if (req.method === "GET" && path === "/v1/servers") {
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!state.tokens.has(bearer)) return answer(res, 401, { code: "unauthorized", error: "Sign in again." });
        return answer(res, 200, { servers: [
            { id: "srv-acme", name: "acme", url: "https://acme.happy-clusters.com/", role: "owner", displayName: "Acme" },
            { id: "srv-globex", name: "globex-labs", url: "https://globex-labs.happy-clusters.com/", role: "member", displayName: "Globex Labs" },
        ] });
    }
    if (req.method === "POST" && path === "/control/reset") {
        state.sent.clear();
        state.wrong.clear();
        return answer(res, 200, {});
    }
    answer(res, 404, { code: "not_found", error: "Not found." });
});

server.listen(PORT, HOST, () => console.log(JSON.stringify({ listening: PORT })));
