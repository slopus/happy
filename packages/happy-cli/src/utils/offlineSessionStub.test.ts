import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('preserves the asynchronous updateAgentState contract while offline', async () => {
        const session = createOfflineSessionStub('test-session');
        const result = session.updateAgentState((state) => state);

        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBeUndefined();
    });
});
