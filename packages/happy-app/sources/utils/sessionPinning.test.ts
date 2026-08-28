import { describe, expect, it } from 'vitest';
import { partitionSessionsByPinnedOrder, sortSessionsForList } from './sessionPinning';

const session = (id: string, createdAt: number) => ({
    id,
    createdAt,
});

describe('sortSessionsForList', () => {
    it('keeps pinned sessions above unpinned sessions ordered by pinned queue order', () => {
        const sorted = sortSessionsForList([
            session('new-unpinned', 400),
            session('old-pinned', 100),
            session('new-pinned', 200),
            session('old-unpinned', 300),
        ], ['old-pinned', 'new-pinned']);

        expect(sorted.map(item => item.id)).toEqual([
            'old-pinned',
            'new-pinned',
            'new-unpinned',
            'old-unpinned',
        ]);
    });

    it('preserves newest-created ordering within unpinned sessions', () => {
        const sorted = sortSessionsForList([
            session('older', 100),
            session('newer', 200),
        ], []);

        expect(sorted.map(item => item.id)).toEqual(['newer', 'older']);
    });

    it('orders unpinned sessions by their latest activity instead of creation time', () => {
        const sorted = sortSessionsForList([
            { id: 'created-today', createdAt: 200, updatedAt: 100 },
            { id: 'continued-today', createdAt: 100, updatedAt: 200 },
        ], []);

        expect(sorted.map(item => item.id)).toEqual(['continued-today', 'created-today']);
    });
});

describe('partitionSessionsByPinnedOrder', () => {
    it('creates one ordered pinned queue and removes those sessions from regular content', () => {
        const partitioned = partitionSessionsByPinnedOrder([
            session('regular-new', 400),
            session('pinned-second', 300),
            session('regular-old', 200),
            session('pinned-first', 100),
        ], ['pinned-first', 'missing', 'pinned-second']);

        expect(partitioned.pinned.map((item) => item.id)).toEqual(['pinned-first', 'pinned-second']);
        expect(partitioned.regular.map((item) => item.id)).toEqual(['regular-new', 'regular-old']);
    });
});
