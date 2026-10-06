import { describe, expect, it } from 'vitest';
import { createServiceAuthorizationLogin, parseServiceAuthorizationLogin, serviceAuthorizationLoginParams, serviceAuthorizationReturnPath } from './serviceAuthorizationLogin';

const id = '00000000-0000-0000-0000-000000000001';
const now = 1_000_000;
describe('explicit service authorization login return', () => {
    it('preserves only the original pairing id and protocol through login routes', () => {
        const intent = createServiceAuthorizationLogin(id, now)!;
        const params = serviceAuthorizationLoginParams(intent);
        expect(parseServiceAuthorizationLogin(params, now + 1000)).toEqual(intent);
        expect(serviceAuthorizationReturnPath(intent, now + 1000)).toBe(`/apps/authorize?id=${id}&protocol=ai-services%2F1`);
    });
    it.each([
        { serviceAuthorizationId: [id] }, { serviceAuthorizationId: 'https://evil.example' },
        { serviceAuthorizationId: '------------------------------------' },
        { serviceAuthorizationProtocol: undefined }, { serviceAuthorizationProtocol: 'ai-services/9' },
        { serviceAuthorizationStartedAt: 'Infinity' }, { serviceAuthorizationStartedAt: 'NaN' },
        { serviceAuthorizationStartedAt: String(now + 1) }, { serviceAuthorizationStartedAt: String(now - 600_000) },
        { serviceAuthorizationStartedAt: [String(now)] },
    ])('rejects malformed or expired return parameters %j', override => {
        const params = { ...serviceAuthorizationLoginParams(createServiceAuthorizationLogin(id, now)!), ...override };
        expect(parseServiceAuthorizationLogin(params, now)).toBeNull();
    });
    it('never accepts an arbitrary returnTo or a cross-origin URL', () => {
        expect(parseServiceAuthorizationLogin({ returnTo: 'https://evil.example' }, now)).toBeNull();
        expect(serviceAuthorizationReturnPath({ id, protocol: 'ai-services/1', startedAt: now, returnTo: 'https://evil.example' }, now)).toBeNull();
        expect(createServiceAuthorizationLogin('//evil.example', now)).toBeNull();
    });
});
