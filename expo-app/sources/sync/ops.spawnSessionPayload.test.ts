import { describe, it, expect } from 'vitest';

import type { SpawnSessionOptions } from './spawnSessionPayload';
import { buildSpawnHappySessionRpcParams } from './spawnSessionPayload';

describe('buildSpawnHappySessionRpcParams', () => {
    it('includes terminal when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            terminal: {
                mode: 'tmux',
                tmux: {
                    sessionName: '',
                    isolated: true,
                    tmpDir: null,
                },
            },
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            type: 'spawn-in-directory',
            directory: '/tmp',
            terminal: {
                mode: 'tmux',
                tmux: {
                    sessionName: '',
                    isolated: true,
                    tmpDir: null,
                },
            },
        });
    });

    it('omits terminal when null/undefined', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            terminal: null,
        } satisfies SpawnSessionOptions);

        expect('terminal' in params).toBe(false);
    });
});
