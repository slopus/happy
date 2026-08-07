import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileBytes } from './readFileBytes.web';

describe('readFileBytes web bounds', () => {
    afterEach(() => vi.restoreAllMocks());

    it('stops an oversized response stream at the hard byte ceiling', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
                controller.enqueue(new Uint8Array([7, 8, 9, 10, 11]));
                controller.close();
            },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));

        await expect(readFileBytes('blob:plan', 10)).rejects.toThrow('read limit');
    });

    it('assembles an in-limit response without calling whole-body arrayBuffer', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.enqueue(new Uint8Array([3, 4]));
                controller.close();
            },
        });
        const response = new Response(stream);
        const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

        await expect(readFileBytes('blob:plan', 10)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(arrayBuffer).not.toHaveBeenCalled();
    });
});
