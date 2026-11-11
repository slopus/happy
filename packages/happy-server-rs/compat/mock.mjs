// The third-party mock both servers reach through COMPAT_MOCK (see fetch-mock.mjs).
// Each request is recorded as a note; `route(host + path)` picks the answer.
import http from 'node:http';

export async function startMock(t, port = Number(new URL(process.env.COMPAT_MOCK || 'http://127.0.0.1:3299').port)) {
    const routes = new Map();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const url = new URL(req.url, 'http://mock');
            const text = Buffer.concat(chunks).toString();
            let body = text;
            try { body = JSON.parse(text); } catch { /* raw */ }
            // Client defaults (undici's `accept: */*`, user agents) are not compared.
            const headers = {};
            for (const n of ['content-type', 'accept', 'authorization', 'xi-api-key']) {
                if (req.headers[n] !== undefined && !(n === 'accept' && req.headers[n] === '*/*')) headers[n] = req.headers[n];
            }
            t.note(`mock ${req.method} ${url.pathname}`, { query: url.search, headers, body });
            const handler = routes.get(url.pathname);
            const out = handler ? await handler({ url, body, headers: req.headers }) : { status: 404, json: { message: 'mock: no route' } };
            res.writeHead(out.status || 200, { 'content-type': out.type || 'application/json' });
            res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json));
        });
    });
    await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
    return {
        route: (path, handler) => routes.set(path, handler),
        close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }),
    };
}
