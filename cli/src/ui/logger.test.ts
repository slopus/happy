import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { appendFileSyncMock } = vi.hoisted(() => ({
    appendFileSyncMock: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        appendFileSync: appendFileSyncMock,
    };
});

describe('logger.debugLargeJson', () => {
    const originalDebug = process.env.DEBUG;

    beforeEach(() => {
        appendFileSyncMock.mockClear();
        delete process.env.DEBUG;
        vi.resetModules();
    });

    afterEach(() => {
        if (originalDebug === undefined) {
            delete process.env.DEBUG;
        } else {
            process.env.DEBUG = originalDebug;
        }
    });

    it('does not write to log file when DEBUG is not set', async () => {
        const { logger } = await import('./logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(appendFileSyncMock).not.toHaveBeenCalled();
    });
});

