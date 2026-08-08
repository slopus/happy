import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileBytes } from './readFileBytes';

const mocks = vi.hoisted(() => ({
    size: 0 as number | null,
    close: vi.fn(),
    readBytes: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
    File: class MockFile {
        open() {
            return {
                get size() { return mocks.size; },
                close: mocks.close,
                readBytes: mocks.readBytes,
            };
        }
    },
}));

describe('readFileBytes native bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.size = 4;
        mocks.readBytes.mockReturnValue(new Uint8Array([1, 2, 3, 4]));
    });

    it('reads exactly the statted byte length and closes the handle', async () => {
        await expect(readFileBytes('file:///tmp/plan.pdf', 10)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(mocks.readBytes).toHaveBeenCalledWith(4);
        expect(mocks.close).toHaveBeenCalledOnce();
    });

    it('rejects an oversized file before allocating its bytes', async () => {
        mocks.size = 11;
        await expect(readFileBytes('file:///tmp/plan.pdf', 10)).rejects.toThrow('read limit');
        expect(mocks.readBytes).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledOnce();
    });
});
