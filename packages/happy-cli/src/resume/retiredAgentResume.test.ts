import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ saved: vi.fn(), resolve: vi.fn(), spawn: vi.fn() }));
vi.mock('@/persistence', () => ({ readPersistedSessions: mocks.saved }));
vi.mock('./resolveHappySession', () => ({ resolveHappySession: mocks.resolve }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }));

import { handleResumeCommand } from './handleResumeCommand';

describe('retired agent resume', () => {
    beforeEach(() => vi.clearAllMocks());

    it.each(['old-personal-session', 'old-personal'])('rejects saved Personal ID/prefix %s without resolving or spawning a replacement', async id => {
        mocks.saved.mockReturnValue({
            'old-personal-session': { metadata: { path: '/saved/workspace', flavor: 'personal' } },
        });

        await expect(handleResumeCommand([id])).rejects.toThrow('Open Bots in Paws to use Rakazo');
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('does not reinterpret a prefix matching several retired sessions', async () => {
        mocks.saved.mockReturnValue({
            'old-one': { metadata: { flavor: 'personal' } },
            'old-two': { metadata: { flavor: 'personal' } },
        });

        await expect(handleResumeCommand(['old-'])).rejects.toThrow('Personal agent has been retired');
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
