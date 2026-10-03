import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { decodeBase64, decryptBoxBundle, encodeBase64, encodeBase64Url, getRandomBytes } from '../crypto/encryption';

export interface DelegatedConnection {
    id: string;
    serverUrl: string;
    token: string;
    key: string;
    machineId: string;
    expiresAt: string | null;
}
export interface DelegatedMessage { role: 'user' | 'assistant'; text: string; images?: string[] }
export interface DelegatedTurn { id: string; input: string; output: string | null; sequence: number; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; createdAt: string }
interface Binding { v: 1; grantId: string; conversationId: string; turnId: string; direction: 'input' | 'output'; sequence: number }
const bytes = new TextEncoder();
function seal(value: unknown, key: string): string {
    const nonce = getRandomBytes(24);
    const encrypted = nacl.secretbox(bytes.encode(JSON.stringify(value)), nonce, decodeBase64(key));
    return encodeBase64(new Uint8Array([...nonce, ...encrypted]));
}
function open(value: string, key: string): Record<string, unknown> {
    const bundle = decodeBase64(value);
    const plain = nacl.secretbox.open(bundle.subarray(24), bundle.subarray(0, 24), decodeBase64(key));
    if (!plain) throw new Error('Cannot decrypt application data');
    return JSON.parse(new TextDecoder().decode(plain));
}
async function request<T>(server: string, path: string, token?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${server}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), credentials: 'omit', redirect: 'error' });
    if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw Object.assign(new Error(typeof result.error === 'string' ? result.error : `Paws request failed (${response.status})`), { status: response.status });
    }
    return response.json() as Promise<T>;
}

/** Creates application-only consent. This never invokes account recovery/login APIs. */
export async function startBrowserAppAuthorization(serverUrl: string, webUrl: string) {
    const server = new URL(serverUrl).origin;
    const web = new URL(webUrl).origin;
    const secure = (value: string) => value.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(value);
    if (!secure(server) || !secure(web)) throw new Error('Paws authorization requires HTTPS');
    const verifier = encodeBase64Url(getRandomBytes(32));
    const credential = encodeBase64Url(getRandomBytes(32));
    const pair = nacl.box.keyPair.fromSecretKey(getRandomBytes(32));
    const challengeHash = Array.from(sha256(bytes.encode(verifier)), b => b.toString(16).padStart(2, '0')).join('');
    const initial = await request<{ id: string; expiresAt: string }>(server, '/v1/apps/pairings', undefined, { appId: 'relationship-advisor', protocol: 2, publicKey: encodeBase64(pair.publicKey), challengeHash });
    return {
        id: initial.id,
        expiresAt: initial.expiresAt,
        qrUrl: `paws:///apps/authorize?id=${initial.id}`,
        approvalUrl: `${web}/apps/authorize?id=${initial.id}`,
        async wait(signal?: AbortSignal): Promise<DelegatedConnection> {
            while (Date.now() < Date.parse(initial.expiresAt)) {
                signal?.throwIfAborted();
                const result = await request<{ state: string; machineId?: string; expiresAt?: string | null; envelope?: string }>(server, `/v1/apps/pairings/${initial.id}/redeem`, undefined, { verifier, credential }, 'POST', signal);
                if (result.state === 'authorized') {
                    if (!result.envelope || !result.machineId || (result.expiresAt !== null && (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()))) throw new Error('Incomplete authorization');
                    const plain = decryptBoxBundle(decodeBase64(result.envelope), pair.secretKey);
                    if (!plain) throw new Error('Invalid authorization envelope');
                    const binding = JSON.parse(new TextDecoder().decode(plain));
                    if (binding.v !== 1 || binding.grantId !== initial.id || binding.appId !== 'relationship-advisor' || binding.machineId !== result.machineId || binding.expiresAt !== result.expiresAt || binding.scope !== 'codex:chat' || typeof binding.key !== 'string' || decodeBase64(binding.key).length !== 32) throw new Error('Authorization binding mismatch');
                    return { id: initial.id, serverUrl: server, token: `paws_app.${initial.id}.${credential}`, key: binding.key, machineId: result.machineId, expiresAt: result.expiresAt };
                }
                await new Promise<void>((resolve, reject) => {
                    const abort = () => { clearTimeout(timer); reject(new Error('Authorization cancelled')); };
                    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1500);
                    signal?.addEventListener('abort', abort, { once: true });
                });
            }
            throw new Error('Authorization QR expired');
        },
    };
}

/** Caller chooses storage policy; default SDK behavior keeps all credentials in memory. */
export function createDelegatedChat(connection: DelegatedConnection) {
    const call = <T>(path: string, body?: unknown, method?: string) => request<T>(connection.serverUrl, `/v1/apps${path}`, connection.token, body, method);
    const binding = (conversationId: string, turnId: string, direction: 'input' | 'output', sequence: number): Binding => ({ v: 1, grantId: connection.id, conversationId, turnId, direction, sequence });
    const decode = (ciphertext: string, expected: Binding) => {
        const data = open(ciphertext, connection.key);
        for (const [key, value] of Object.entries(expected)) if (data[key] !== value) throw new Error('Application message context mismatch');
        return data;
    };
    return {
        check: () => call('/connection'),
        disconnect: () => call('/connection', undefined, 'DELETE'),
        conversations: () => call<{ conversations: { id: string; createdAt: string }[] }>('/conversations'),
        deleteConversation: (id: string) => call(`/conversations/${id}`, undefined, 'DELETE'),
        async createConversation(id = globalThis.crypto.randomUUID()) { await call('/conversations', { id }); return id; },
        async send(conversationId: string, messages: DelegatedMessage[], id = globalThis.crypto.randomUUID()) {
            if (messages.length > 100 || JSON.stringify(messages).length > 5 * 1024 * 1024) throw new Error('Conversation is too large');
            const input = seal({ ...binding(conversationId, id, 'input', 0), messages }, connection.key);
            if (input.length > 8 * 1024 * 1024) throw new Error('Encrypted conversation is too large');
            await call(`/conversations/${conversationId}/turns`, { id, input });
            return id;
        },
        async turns(conversationId: string, before?: string) {
            const result = await call<{ turns: DelegatedTurn[] }>(`/conversations/${conversationId}/turns${before ? `?before=${encodeURIComponent(before)}` : ''}`);
            return result.turns.map(turn => ({ ...turn,
                messages: decode(turn.input, binding(conversationId, turn.id, 'input', 0)).messages as DelegatedMessage[],
                text: turn.output ? decode(turn.output, binding(conversationId, turn.id, 'output', turn.sequence)).text as string : '',
            }));
        },
        async turn(conversationId: string, turnId: string) {
            const turn = await call<Omit<DelegatedTurn, 'input' | 'createdAt'>>(`/turns/${turnId}`);
            return { ...turn, text: turn.output ? decode(turn.output, binding(conversationId, turn.id, 'output', turn.sequence)).text as string : '' };
        },
        stop: (turnId: string) => call(`/turns/${turnId}/cancel`, {}),
    };
}
