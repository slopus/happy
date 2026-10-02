import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createDelegatedChat } from './browserDelegation';
import { encodeBase64, getRandomBytes } from '../crypto/encryption';
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
