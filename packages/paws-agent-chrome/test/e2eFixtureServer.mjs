import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Server as SocketServer } from 'socket.io';
import tweetnacl from 'tweetnacl';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MACHINE_ID = 'paws-e2e-machine';
const SESSION_ID = 'paws-e2e-session';
const TOKEN = 'paws-e2e-token';

export async function startE2eFixtureServer(extensionDir, { injectContentScript = true } = {}) {
    const secret = tweetnacl.randomBytes(32);
    const state = {
        authRequests: 0,
        spawnRequests: 0,
        approvedSpawnRequests: 0,
        plainPrompts: [],
        sessionCreated: false,
        agentRequestPending: false,
        requestResolutionCalls: 0,
    };
    const messages = [];
    let linkPublicKey = null;

    const server = createServer(async (request, response) => {
        setCorsHeaders(request, response);
        if (request.method === 'OPTIONS') {
            response.writeHead(204);
            response.end();
            return;
        }

        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        try {
            if (url.pathname === '/') {
                const contentScript = injectContentScript ? '<script src="/content.js"></script>' : '';
                send(response, 200, `<!doctype html><html><head><title>Paws Extension E2E Fixture</title></head><body><main><h1>Remote debugging fixture</h1><p id="issue">Payment failed with code 42</p></main>${contentScript}</body></html>`, 'text/html; charset=utf-8');
                return;
            }
            const staticPath = url.pathname.slice(1);
            if (['content.js', 'panel.js', 'panel.html', 'styles.css'].includes(staticPath)) {
                const content = await readFile(join(extensionDir, staticPath));
                const contentType = extname(staticPath) === '.js'
                    ? 'text/javascript; charset=utf-8'
                    : extname(staticPath) === '.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
                send(response, 200, content, contentType);
                return;
            }
            if (url.pathname === '/__state') {
                sendJson(response, state);
                return;
            }
            if (url.pathname === '/v1/auth/account/request' && request.method === 'POST') {
                const body = await readJson(request);
                state.authRequests += 1;
                if (typeof body.publicKey !== 'string') throw new Error('publicKey is required');
                if (linkPublicKey !== body.publicKey) {
                    linkPublicKey = body.publicKey;
                    sendJson(response, { state: 'requested' });
                    return;
                }
                const encryptedSecret = encryptForPublicKey(secret, fromBase64(linkPublicKey));
                sendJson(response, {
                    state: 'authorized',
                    token: TOKEN,
                    response: toBase64(encryptedSecret),
                });
                return;
            }

            requireAuthorization(request);
            if (url.pathname === '/v1/machines' && request.method === 'GET') {
                sendJson(response, [machineRecord(secret)]);
                return;
            }
            if ((url.pathname === '/v1/sessions' || url.pathname === '/v2/sessions/active') && request.method === 'GET') {
                sendJson(response, { sessions: state.sessionCreated ? [sessionRecord(secret, state)] : [] });
                return;
            }
            if (url.pathname === `/v3/sessions/${SESSION_ID}/messages` && request.method === 'POST') {
                const body = await readJson(request);
                const item = body.messages?.[0];
                if (typeof item?.content !== 'string' || typeof item?.localId !== 'string') {
                    throw new Error('message payload is malformed');
                }
                const plainContent = decryptLegacy(fromBase64(item.content), secret);
                const prompt = plainContent?.content?.text;
                if (typeof prompt !== 'string') throw new Error('message could not be decrypted');
                state.plainPrompts.push(prompt);
                const now = Date.now();
                messages.push(rawMessage(`user-${messages.length + 1}`, messages.length + 1, item.localId, plainContent, secret, now));
                messages.push(rawMessage(`agent-${messages.length + 1}`, messages.length + 1, null, {
                    role: 'agent',
                    content: { type: 'text', text: 'E2E fixture reply: remote session is ready.' },
                }, secret, now + 1));
                sendJson(response, { success: true });
                return;
            }
            if (url.pathname === `/v3/sessions/${SESSION_ID}/messages` && request.method === 'GET') {
                sendJson(response, { messages });
                return;
            }

            send(response, 404, 'not found');
        } catch (error) {
            sendJson(response, error.message === 'unauthorized' ? 401 : 500, { error: error.message });
        }
    });

    const io = new SocketServer(server, {
        path: '/v1/updates',
        transports: ['websocket'],
        cors: { origin: true, credentials: false },
    });
    io.use((socket, next) => {
        next(socket.handshake.auth?.token === TOKEN ? undefined : new Error('unauthorized'));
    });
    io.on('connection', socket => {
        socket.on('rpc-call', (payload, acknowledge) => {
            try {
                const params = decryptLegacy(fromBase64(payload?.params), secret);
                if (payload?.method === `${SESSION_ID}:permission`) {
                    state.requestResolutionCalls += 1;
                    acknowledge({ ok: true, result: toBase64(encryptLegacy({ success: true }, secret)) });
                    return;
                }
                if (payload?.method !== `${MACHINE_ID}:spawn-happy-session`) {
                    acknowledge({ ok: false, error: 'RPC method not available' });
                    return;
                }
                state.spawnRequests += 1;
                if (params?.approvedNewDirectoryCreation !== true) {
                    acknowledge({
                        ok: true,
                        result: toBase64(encryptLegacy({
                            type: 'requestToApproveDirectoryCreation',
                            directory: params?.directory ?? '/tmp/paws-e2e-project',
                        }, secret)),
                    });
                    return;
                }
                state.approvedSpawnRequests += 1;
                state.sessionCreated = true;
                acknowledge({
                    ok: true,
                    result: toBase64(encryptLegacy({ type: 'success', sessionId: SESSION_ID }, secret)),
                });
            } catch (error) {
                acknowledge({ ok: false, error: error.message });
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('E2E fixture did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    return {
        origin,
        state,
        emitAgentRequest() {
            state.agentRequestPending = true;
            io.emit('update', { body: { t: 'update-session', id: SESSION_ID } });
        },
        async close() {
            await new Promise(resolve => io.close(resolve));
            if (server.listening) await new Promise(resolve => server.close(resolve));
        },
    };
}

function machineRecord(secret) {
    const now = Date.now();
    return {
        id: MACHINE_ID,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: toBase64(encryptLegacy({ displayName: 'E2E Mac mini', hostname: 'e2e-mac-mini' }, secret)),
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
    };
}

function sessionRecord(secret, state) {
    const now = Date.now();
    return {
        id: SESSION_ID,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: toBase64(encryptLegacy({ machineId: MACHINE_ID, path: '/tmp/paws-e2e-project' }, secret)),
        metadataVersion: 1,
        agentState: state.agentRequestPending ? toBase64(encryptLegacy({
            requests: {
                'fixture-bash-request': {
                    tool: 'Bash',
                    arguments: {
                        command: 'echo paws-e2e-safe-request',
                        cwd: '/tmp/paws-e2e-project',
                    },
                },
            },
        }, secret)) : null,
        agentStateVersion: state.agentRequestPending ? 1 : 0,
        dataEncryptionKey: null,
    };
}

function rawMessage(id, seq, localId, content, secret, timestamp) {
    return {
        id,
        seq,
        content: { t: 'encrypted', c: toBase64(encryptLegacy(content, secret)) },
        localId,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function encryptForPublicKey(data, recipientPublicKey) {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);
    return concat(ephemeral.publicKey, nonce, encrypted);
}

function encryptLegacy(value, secret) {
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
    return concat(nonce, tweetnacl.secretbox(encoder.encode(JSON.stringify(value)), nonce, secret));
}

function decryptLegacy(value, secret) {
    const opened = tweetnacl.secretbox.open(value.slice(tweetnacl.secretbox.nonceLength), value.slice(0, tweetnacl.secretbox.nonceLength), secret);
    return opened ? JSON.parse(decoder.decode(opened)) : null;
}

function concat(...values) {
    const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
    let offset = 0;
    for (const value of values) {
        result.set(value, offset);
        offset += value.length;
    }
    return result;
}

function fromBase64(value) {
    return new Uint8Array(Buffer.from(value, 'base64'));
}

function toBase64(value) {
    return Buffer.from(value).toString('base64');
}

function requireAuthorization(request) {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) throw new Error('unauthorized');
}

async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function setCorsHeaders(request, response) {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Happy-Client');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response, statusOrValue, maybeValue) {
    const status = typeof statusOrValue === 'number' ? statusOrValue : 200;
    const value = typeof statusOrValue === 'number' ? maybeValue : statusOrValue;
    send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
    if (response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
}
