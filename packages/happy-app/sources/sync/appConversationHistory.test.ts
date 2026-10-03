import { beforeAll, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(size) }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: sodium }));
import { decryptAppConversationHistory, parseAppConversationHistory, type AppConversationHistory } from './appConversationHistory';
const key = new Uint8Array(32).fill(7);
const envelope = { v: 1, grantId: 'grant', machineId: 'machine', appId: 'relationship-advisor', scope: 'codex:chat', expiresAt: null, key: Buffer.from(key).toString('base64') };
const context = { v: 1, grantId: 'grant', conversationId: 'conversation', turnId: 'turn' };
const base: AppConversationHistory = { app: { id: 'relationship-advisor', origin: 'https://advisor.paws.rodeo' }, conversationId: 'conversation', grantId: 'grant', machineId: 'machine', grantExpiresAt: null, machineEnvelope: 'sealed', createdAt: '2026-10-03T07:00:00.000Z', turns: [] };
beforeAll(async () => { await sodium.ready; });
function seal(value: unknown) {
    const nonce = new Uint8Array(24);
    return Buffer.from([...nonce, ...sodium.crypto_secretbox_easy(new TextEncoder().encode(JSON.stringify(value)), nonce, key)]).toString('base64');
}
function history(input: Record<string, unknown> = {}, output: Record<string, unknown> = {}): AppConversationHistory {
    return { ...base, turns: [{ id: 'turn', input: seal({ ...context, direction: 'input', sequence: 0, messages: [{ role: 'user', text: 'Original question' }], ...input }), output: seal({ ...context, direction: 'output', sequence: 2, text: 'Original answer', ...output }), sequence: 2, state: 'completed', createdAt: base.createdAt }] };
}
it('reads original encrypted messages and safe images in Paws without producing credentials or a URL', () => {
    const result = decryptAppConversationHistory(history({ messages: [{ role: 'user', text: 'Question', images: Array(4).fill('data:image/png;base64,AA==') }] }), envelope);
    expect(result.messages).toEqual([{ role: 'user', text: 'Question', images: Array(4).fill('data:image/png;base64,AA==') }, { role: 'assistant', text: 'Original answer' }]);
    expect(result).not.toHaveProperty('token'); expect(result).not.toHaveProperty('key');
});
it.each(['grantId', 'machineId', 'appId', 'scope', 'expiresAt', 'v', 'key'])('rejects wrong envelope %s', field => {
    expect(() => decryptAppConversationHistory(history(), { ...envelope, [field]: 'wrong' })).toThrow();
});
it.each(['grantId', 'conversationId', 'turnId', 'direction', 'sequence'])('rejects replayed input or output %s', field => {
    expect(() => decryptAppConversationHistory(history({ [field]: 'wrong' }), envelope)).toThrow();
    expect(() => decryptAppConversationHistory(history({}, { [field]: 'wrong' }), envelope)).toThrow();
});
it('checks selected conversation, app origin and safe image sources', () => {
    expect(() => parseAppConversationHistory(base, 'different')).toThrow();
    expect(() => parseAppConversationHistory({ ...base, app: { ...base.app, origin: 'https://other.example' } }, base.conversationId)).toThrow();
    expect(() => decryptAppConversationHistory(history({ messages: [{ role: 'user', text: '', images: ['https://tracking.example/image'] }] }), envelope)).toThrow();
});
it('supports empty, running, failed and cancelled history', () => {
    expect(decryptAppConversationHistory(base, envelope)).toMatchObject({ messages: [], state: 'idle' });
    for (const state of ['running', 'failed', 'cancelled'] as const) {
        const data = history(); data.turns[0] = { ...data.turns[0], output: null, state };
        expect(decryptAppConversationHistory(data, envelope)).toMatchObject({ messages: [{ role: 'user', text: 'Original question' }], state });
    }
});
it('binds protocol 3 scopes and Codex/Claude model selections', () => {
    const selection = { engine: 'claude', model: 'claude-opus-4-6' };
    const data = { ...history({ v: 2, selection }, { v: 2, selection }), grantProtocol: 3 };
    const modern = { ...envelope, scope: 'agent:chat', protocol: 3 };
    expect(decryptAppConversationHistory(data, modern).messages[1].selection).toEqual(selection);
    expect(() => decryptAppConversationHistory(data, envelope)).toThrow();
    expect(() => decryptAppConversationHistory(history({ v: 2, selection }, { v: 2, selection: { ...selection, engine: 'codex' } }), envelope)).toThrow();
    expect(() => decryptAppConversationHistory(history({ v: 2 }), envelope)).toThrow();
});
