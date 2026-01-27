import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from '@/api/offline/offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('returns an EventEmitter-compatible ApiSessionClient', () => {
        const session = createOfflineSessionStub('tag');

        let calls = 0;
        session.on('message', () => {
            calls += 1;
        });
        session.emit('message', { ok: true });

        expect(calls).toBe(1);
    });
});
