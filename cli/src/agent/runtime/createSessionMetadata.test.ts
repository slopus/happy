import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: '/tmp/happy-home',
    },
}));

vi.mock('@/projectPath', () => ({
    projectPath: () => '/tmp/happy-lib',
}));

vi.mock('../../package.json', () => ({
    default: { version: '0.0.0-test' },
}));

import { createSessionMetadata } from './createSessionMetadata';

describe('createSessionMetadata', () => {
    it('seeds messageQueueV1 so the app can safely detect queue support', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        });

        expect(metadata.messageQueueV1).toEqual({
            v: 1,
            queue: [],
        });
    });
});

