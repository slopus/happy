import { describe, expect, it, vi } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('returns an EventEmitter-compatible ApiSessionClient', () => {
        const session = createOfflineSessionStub('tag');

        const handler = vi.fn();
        session.on('message', handler);
        session.emit('message', { ok: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });
});

