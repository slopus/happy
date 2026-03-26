import { describe, expect, it, vi } from "vitest";

describe('runShutdownHandlers', () => {
    it('runs shutdown groups sequentially in reverse registration order', async () => {
        vi.resetModules();

        const { onShutdown, runShutdownHandlers } = await import('@/utils/shutdown');
        const events: string[] = [];
        let releaseBackplane!: () => void;

        const backplaneFinished = new Promise<void>((resolve) => {
            releaseBackplane = resolve;
        });

        onShutdown('db', async () => {
            events.push('db:start');
        });
        onShutdown('backplane', async () => {
            events.push('backplane:start');
            await backplaneFinished;
            events.push('backplane:end');
        });

        const shutdownPromise = runShutdownHandlers();
        await Promise.resolve();

        expect(events).toEqual(['backplane:start']);

        releaseBackplane();
        await shutdownPromise;

        expect(events).toEqual(['backplane:start', 'backplane:end', 'db:start']);
    });
});
