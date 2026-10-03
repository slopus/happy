import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createDelegatedChat, startBrowserAppAuthorization } from './browserDelegation';
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
                expect(body.protocol).toBe(2);
                recipient = decodeBase64(body.publicKey);
                return new Response(JSON.stringify({ id: 'grant', expiresAt: new Date(Date.now() + 600_000).toISOString() }));
            }
            const sender = nacl.box.keyPair();
            const nonce = getRandomBytes(24);
            const binding = { v: 1, grantId: 'grant', appId: 'relationship-advisor', machineId: 'machine', expiresAt, scope: 'codex:chat', key: connection.key };
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
