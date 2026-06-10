import { describe, expect, it, vi } from 'vitest';

import { createSerialAsyncHandler } from './serialAsyncHandler';

async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createSerialAsyncHandler', () => {
    it('runs async callbacks in arrival order even when the first one is slow', async () => {
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstDone = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const handle = createSerialAsyncHandler<string>(async (value) => {
            events.push(`start:${value}`);
            if (value === 'first') {
                await firstDone;
            }
            events.push(`end:${value}`);
        });

        handle('first');
        handle('second');
        await tick();

        expect(events).toEqual(['start:first']);

        releaseFirst();
        await tick();
        await tick();

        expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    });

    it('reports handler errors and keeps later callbacks ordered', async () => {
        const events: string[] = [];
        const onError = vi.fn();
        const handle = createSerialAsyncHandler<string>(async (value) => {
            events.push(value);
            if (value === 'first') {
                throw new Error('failed');
            }
        }, onError);

        handle('first');
        handle('second');
        await tick();
        await tick();

        expect(events).toEqual(['first', 'second']);
        expect(onError).toHaveBeenCalledTimes(1);
    });
});
