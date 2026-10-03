import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createDelegatedChat, createDelegatedHistoryReader, startBrowserAppAuthorization } from './browserDelegation';
import { decodeBase64, encodeBase64, getRandomBytes } from '../crypto/encryption';
const key = getRandomBytes(32);
const connection = { id: 'grant', serverUrl: 'https://paws.example', token: 'paws_app.grant.secret', key: encodeBase64(key), machineId: 'machine', expiresAt: new Date(Date.now() + 60000).toISOString() };
function encrypted(data: unknown) {
    const nonce = getRandomBytes(24);
    const cipher = nacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, key);
    return encodeBase64(new Uint8Array([...nonce, ...cipher]));
}
afterEach(() => vi.unstubAllGlobals());
describe('delegated message context', () => {
    it.each(['grantId', 'conversationId', 'turnId', 'direction', 'sequence'])('rejects replay with mismatched %s', async field => {
        const body = { v: 1, grantId: 'grant', conversationId: 'conversation', turnId: 'turn', direction: 'output', sequence: 1, text: 'private reply', [field]: 'wrong' };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'turn', output: encrypted(body), sequence: 1, state: 'completed' }))));
        await expect(createDelegatedChat(connection).turn('conversation', 'turn')).rejects.toThrow('context mismatch');
    });
    it('decrypts only the scoped turn and sends no account credential', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'turn', output: encrypted({ v: 1, grantId: 'grant', conversationId: 'conversation', turnId: 'turn', direction: 'output', sequence: 2, text: 'answer' }), sequence: 2, state: 'completed' })));
        vi.stubGlobal('fetch', fetcher);
        expect((await createDelegatedChat(connection).turn('conversation', 'turn')).text).toBe('answer');
        const args = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(args[0]).toBe('https://paws.example/v1/apps/turns/turn');
        expect(args[1].headers).toMatchObject({ Authorization: `Bearer ${connection.token}` });
    });
});


describe('authorization expiry binding', () => {
    it.each([null, new Date(Date.now() + 86400_000).toISOString()])('redeems a sealed envelope with expiresAt %s', async expiresAt => {
        let recipient: Uint8Array;
        const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (body.appId) {
                expect(body.protocol).toBe(3);
                recipient = decodeBase64(body.publicKey);
                return new Response(JSON.stringify({ id: 'grant', expiresAt: new Date(Date.now() + 600_000).toISOString() }));
            }
            const sender = nacl.box.keyPair();
            const nonce = getRandomBytes(24);
            const binding = { v: 1, grantId: 'grant', appId: 'relationship-advisor', machineId: 'machine', expiresAt, scope: 'agent:chat', protocol: 3, key: connection.key };
            const ciphertext = nacl.box(new TextEncoder().encode(JSON.stringify(binding)), nonce, recipient!, sender.secretKey);
            return new Response(JSON.stringify({ state: 'authorized', machineId: 'machine', expiresAt, envelope: encodeBase64(new Uint8Array([...sender.publicKey, ...nonce, ...ciphertext])) }));
        });
        vi.stubGlobal('fetch', fetcher);
        const pending = await startBrowserAppAuthorization('https://paws.example', 'https://app.example');
        expect((await pending.wait()).expiresAt).toBe(expiresAt);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each([undefined, '', 'invalid', new Date(0).toISOString()])('rejects missing or invalid expiry %s instead of treating it as permanent', async expiresAt => {
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(JSON.parse(init.body as string).appId
            ? { id: 'grant', expiresAt: new Date(Date.now() + 600_000).toISOString() }
            : { state: 'authorized', machineId: 'machine', expiresAt, envelope: 'invalid' }))));
        const pending = await startBrowserAppAuthorization('https://paws.example', 'https://app.example');
        await expect(pending.wait()).rejects.toThrow('Incomplete authorization');
    });
});


describe('read-only history', () => {
    const access = { v: 1 as const, appId: 'relationship-advisor' as const, conversationId: 'conversation', grantId: 'grant', key: connection.key, token: 'paws_history.scoped', expiresAt: connection.expiresAt };
    const binding = { v: 1, grantId: 'grant', conversationId: 'conversation', turnId: 'turn', direction: 'input', sequence: 0 };
    const result = (input: unknown) => ({ conversationId: 'conversation', createdAt: '', turns: [{ id: 'turn', input: encrypted(input), output: null, sequence: 0, state: 'completed', createdAt: '' }] });
    it('only offers reading, decrypts history and uses the dedicated capability endpoint', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify(result({ ...binding, messages: [{ role: 'user', text: 'old conversation', images: Array(4).fill('data:image/png;base64,AA==') }] }))));
        vi.stubGlobal('fetch', fetcher);
        const reader = createDelegatedHistoryReader(connection.serverUrl, access);
        expect(Object.keys(reader)).toEqual(['read']);
        const history = await reader.read();
        expect(history.turns[0].messages[0].text).toBe('old conversation');
        expect(history.turns[0].messages[0].images).toHaveLength(4);
        expect(fetcher).toHaveBeenCalledWith('https://paws.example/v1/apps/history/conversation', expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer paws_history.scoped' } }));
    });
    it.each(['grantId', 'conversationId', 'turnId', 'direction', 'sequence'])('rejects swapped encrypted history %s', async field => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(result({ ...binding, [field]: 'wrong', messages: [] })))));
        await expect(createDelegatedHistoryReader(connection.serverUrl, access).read()).rejects.toThrow('context mismatch');
    });
    it('rejects malformed message data and remote image tracking', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(result({ ...binding, messages: [{ role: 'user', text: 'x', images: ['https://tracker.example'] }] })))));
        await expect(createDelegatedHistoryReader(connection.serverUrl, access).read()).rejects.toThrow('Invalid application history');
    });
});
describe('model selection binding', () => {
    it('keeps a legacy grant restricted to Codex and sends no network request for Claude', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        await expect(createDelegatedChat(connection).send('conversation', [{ role: 'user', text: 'hi' }], 'turn', { engine: 'claude', model: 'sonnet' })).rejects.toThrow('授权');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('seals settings and requires a new worker; old workers reject wire v2', async () => {
        const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher);
        await createDelegatedChat(connection).send('conversation', [{ role: 'user', text: 'hi' }], 'turn', { engine: 'codex', model: 'gpt-6-luna' });
        const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(body.minimumProtocol).toBe(3);
        expect(body).not.toHaveProperty('selection');
        const cipher = decodeBase64(body.input);
        const input = JSON.parse(new TextDecoder().decode(nacl.secretbox.open(cipher.subarray(24), cipher.subarray(0, 24), key)!));
        expect(input).toMatchObject({ v: 2, selection: { engine: 'codex', model: 'gpt-6-luna' } });
    });
    it('rejects output for a different model while reading history', async () => {
        const binding = { v: 2, grantId: 'grant', conversationId: 'conversation', turnId: 'turn' };
        const input = encrypted({ ...binding, direction: 'input', sequence: 0, messages: [], selection: { engine: 'codex', model: 'gpt-6-luna' } });
        const output = encrypted({ ...binding, direction: 'output', sequence: 1, text: 'wrong', selection: { engine: 'codex', model: 'gpt-6-astra' } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ turns: [{ id: 'turn', input, output, sequence: 1 }] }))));
        await expect(createDelegatedChat(connection).turns('conversation')).rejects.toThrow('model context mismatch');
    });
});


it('projects legacy second-turn history to the strict v1 worker schema', async () => {
    const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher);
    await createDelegatedChat(connection).send('conversation', [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'answer', selection: { engine: 'codex', model: 'gpt-6-astra' }, actualModel: 'gpt-6-astra' },
        { role: 'user', text: 'second' },
    ], 'second-turn');
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('minimumProtocol');
    const cipher = decodeBase64(body.input);
    const input = JSON.parse(new TextDecoder().decode(nacl.secretbox.open(cipher.subarray(24), cipher.subarray(0, 24), key)!));
    expect(input.v).toBe(1);
    expect(input.messages[1]).toEqual({ role: 'assistant', text: 'answer' });
});

it('reads v2 model-bound history through the read-only reader', async () => {
    const access = { v: 1 as const, appId: 'relationship-advisor' as const, conversationId: 'conversation', grantId: 'grant', key: connection.key, token: 'paws_history.scoped', expiresAt: connection.expiresAt };
    const binding = { v: 2, grantId: 'grant', conversationId: 'conversation', turnId: 'turn', selection: { engine: 'claude', model: 'opus' } };
    const input = encrypted({ ...binding, direction: 'input', sequence: 0, messages: [{ role: 'user', text: 'hello' }] });
    const output = encrypted({ ...binding, direction: 'output', sequence: 1, text: 'answer', actualModel: 'resolved-opus' });
    const payload = { conversationId: 'conversation', turns: [{ id: 'turn', input, output, sequence: 1 }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload))));
    expect((await createDelegatedHistoryReader(connection.serverUrl, access).read()).turns[0]).toMatchObject({ text: 'answer', selection: { engine: 'claude', model: 'opus' }, actualModel: 'resolved-opus' });
    payload.turns[0].output = encrypted({ ...binding, direction: 'output', sequence: 1, text: 'wrong', selection: { engine: 'codex', model: 'gpt-6-astra' } });
    await expect(createDelegatedHistoryReader(connection.serverUrl, access).read()).rejects.toThrow('model context mismatch');
});
