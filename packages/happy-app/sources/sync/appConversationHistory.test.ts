import { expect, it } from 'vitest';
import { appConversationHistoryUrl } from './appConversationHistory';
const access = { app: { id: 'relationship-advisor', origin: 'https://advisor.paws.rodeo' }, conversationId: 'conversation', grantId: 'grant', machineId: 'machine', grantExpiresAt: null, machineEnvelope: 'private-machine-envelope', token: 'paws_history.token', expiresAt: new Date(Date.now() + 60000).toISOString() };
const envelope = { v: 1, grantId: 'grant', machineId: 'machine', appId: 'relationship-advisor', scope: 'codex:chat', expiresAt: null, key: 'A'.repeat(43) + '=' };
const expected = { conversationId: 'conversation', grantId: 'grant', machineId: 'machine' };
it('hands off only application history credentials in a fragment', () => {
    const url = new URL(appConversationHistoryUrl(access, envelope, expected));
    expect(url.origin).toBe('https://advisor.paws.rodeo');
    expect(url.searchParams.get('pawsConversation')).toBe('conversation');
    const data = JSON.parse(decodeURIComponent(url.hash.slice('#paws-history='.length)));
    expect(Object.keys(data).sort()).toEqual(['appId', 'conversationId', 'expiresAt', 'grantId', 'key', 'token', 'v']);
    expect(url.search).not.toContain('token');
    expect(url.href).not.toContain(access.machineEnvelope);
});
it.each(['grantId', 'machineId', 'appId', 'scope', 'expiresAt', 'v', 'key'])('refuses incorrect decrypted %s binding', field => {
    expect(() => appConversationHistoryUrl(access, { ...envelope, [field]: 'wrong' }, expected)).toThrow();
});
it('refuses other application origins and conversations, even with a valid envelope', () => {
    expect(() => appConversationHistoryUrl({ ...access, app: { ...access.app, origin: 'https://attacker.example' } }, envelope, expected)).toThrow();
    expect(() => appConversationHistoryUrl({ ...access, conversationId: 'another' }, envelope, expected)).toThrow();
    expect(() => appConversationHistoryUrl({ ...access, expiresAt: new Date(0).toISOString() }, envelope, expected)).toThrow();
});

it('reads protocol 3 history without granting execution or accepting mismatched scope', () => {
    const modern = { ...access, grantProtocol: 3 };
    expect(appConversationHistoryUrl(modern, { ...envelope, scope: 'agent:chat', protocol: 3 }, expected)).toContain('#paws-history=');
    expect(() => appConversationHistoryUrl(modern, envelope, expected)).toThrow();
    expect(() => appConversationHistoryUrl(access, { ...envelope, scope: 'agent:chat', protocol: 3 }, expected)).toThrow();
});
