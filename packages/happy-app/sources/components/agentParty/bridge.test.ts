import { describe, it, expect } from 'vitest';
import { AGENT_PARTY_RELAY, AGENT_PARTY_URL, parsePartySessionMessage, partyFrameUrl } from './bridge';
describe('AgentParty account-bound bridge', () => {
    const message = { type: 'agent-party-session', accountId: 'account-a', serverUrl: AGENT_PARTY_RELAY, sessionId: 'session-1' };
    it('routes only the current account and server', () => {
        expect(parsePartySessionMessage(message, 'account-a', AGENT_PARTY_RELAY)).toBe('session-1');
        expect(parsePartySessionMessage(message, 'account-b', AGENT_PARTY_RELAY)).toBeNull();
        expect(parsePartySessionMessage({ ...message, serverUrl: 'https://evil.test' }, 'account-a', AGENT_PARTY_RELAY)).toBeNull();
        expect(parsePartySessionMessage({ ...message, sessionId: '../settings' }, 'account-a', AGENT_PARTY_RELAY)).toBeNull();
    });
    it('puts only a short-lived ticket in the fragment and rejects malformed values', () => {
        const ticket = 'x'.repeat(43);
        expect(partyFrameUrl(ticket, true)).toBe(`${AGENT_PARTY_URL}?view=agents#ticket=${ticket}`);
        expect(() => partyFrameUrl('secret&redirect=evil', false)).toThrow();
    });
});
