import { describe, it, expect } from 'vitest';

import { MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('should preserve terminal metadata when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            terminal: {
                mode: 'tmux',
                requested: 'tmux',
                tmux: {
                    target: 'happy:win-1',
                    tmpDir: '/tmp/happy-tmux',
                },
            },
        } as any);

        expect((parsed as any).terminal).toEqual({
            mode: 'tmux',
            requested: 'tmux',
            tmux: {
                target: 'happy:win-1',
                tmpDir: '/tmp/happy-tmux',
            },
        });
    });

    it('should preserve Auggie vendor session metadata when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            auggieSessionId: 'auggie-session-1',
            auggieAllowIndexing: true,
        } as any);

        expect((parsed as any).auggieSessionId).toBe('auggie-session-1');
        expect((parsed as any).auggieAllowIndexing).toBe(true);
    });
});
