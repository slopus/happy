import { describe, expect, it } from 'vitest';
import { createAccountSessionLink, parseAccountSessionTarget } from './accountLink';

describe('account-aware session links', () => {
    const target = { accountId: 'miss-account', serverUrl: 'https://relay.example.com', sessionId: 'session-123' };
    it('roundtrips only public identifiers', () => {
        const url = new URL(createAccountSessionLink('https://paws.example.com', target));
        expect(url.pathname).toBe('/accounts');
        expect([...url.searchParams.keys()].sort()).toEqual(['accountId', 'serverUrl', 'sessionId']);
        expect(parseAccountSessionTarget(Object.fromEntries(url.searchParams))).toEqual(target);
    });
    it('rejects incomplete, ambiguous, credential-bearing and unsafe links', () => {
        for (const params of [{ ...target, sessionId: '../settings' }, { ...target, accountId: ['a', 'b'] }, { ...target, serverUrl: 'https://user:secret@example.com' }, { ...target, serverUrl: 'javascript:alert(1)' }, { sessionId: 's' }]) {
            expect(parseAccountSessionTarget(params)).toBeNull();
        }
    });
});
