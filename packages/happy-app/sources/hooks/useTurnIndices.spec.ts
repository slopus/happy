import { describe, it, expect } from 'vitest';
import { extractTurnIndices, navigateTurn, TurnInfo, PAGE_SIZE } from './useTurnIndices';
import { Message } from '@/sync/typesMessage';

// Helper to build a minimal Message array (newest-first order)
function makeMessages(...kinds: Array<'user' | 'agent' | 'tool'>): Message[] {
    return kinds.map((k, i) => {
        if (k === 'user') {
            return {
                kind: 'user-text' as const,
                id: `msg-${i}`,
                localId: null,
                createdAt: 1000 - i * 10,
                text: `User message ${i}`,
            };
        }
        if (k === 'agent') {
            return {
                kind: 'agent-text' as const,
                id: `msg-${i}`,
                localId: null,
                createdAt: 1000 - i * 10,
                text: `Agent reply ${i}`,
            };
        }
        return {
            kind: 'tool-call' as const,
            id: `msg-${i}`,
            localId: null,
            createdAt: 1000 - i * 10,
            tool: { name: 'Read', state: 'completed' as const, input: {}, createdAt: 0, startedAt: 0, completedAt: 0, description: null },
            children: [],
        };
    });
}

// Helper to make a simple TurnInfo array for navigateTurn tests
function makeTurns(count: number): TurnInfo[] {
    // turns[0] = newest (turnNumber = count), turns[count-1] = oldest (turnNumber = 1)
    return Array.from({ length: count }, (_, i) => ({
        index: i * 3,
        turnNumber: count - i,
        preview: `Turn ${count - i}`,
    }));
}

// ============================================================================
// extractTurnIndices
// ============================================================================

describe('extractTurnIndices', () => {
    it('returns empty array for no messages', () => {
        expect(extractTurnIndices([])).toEqual([]);
    });

    it('returns empty array when there are no user-text messages', () => {
        const msgs = makeMessages('agent', 'tool', 'agent');
        expect(extractTurnIndices(msgs)).toEqual([]);
    });

    it('finds a single turn', () => {
        const msgs = makeMessages('user', 'agent');
        const turns = extractTurnIndices(msgs);
        expect(turns).toHaveLength(1);
        expect(turns[0].turnNumber).toBe(1);
        expect(turns[0].index).toBe(0);
    });

    it('assigns turn numbers oldest=1, newest=N in newest-first data', () => {
        // Newest-first: [user3, agent3, user2, agent2, user1, agent1]
        const msgs = makeMessages('user', 'agent', 'user', 'agent', 'user', 'agent');
        const turns = extractTurnIndices(msgs);

        expect(turns).toHaveLength(3);
        // turns[0] is the newest user-text (index 0), gets turnNumber 3
        expect(turns[0]).toMatchObject({ index: 0, turnNumber: 3 });
        // turns[1] is the second newest (index 2), gets turnNumber 2
        expect(turns[1]).toMatchObject({ index: 2, turnNumber: 2 });
        // turns[2] is the oldest (index 4), gets turnNumber 1
        expect(turns[2]).toMatchObject({ index: 4, turnNumber: 1 });
    });

    it('skips agent-text and tool-call messages', () => {
        const msgs = makeMessages('user', 'agent', 'tool', 'agent', 'user', 'tool');
        const turns = extractTurnIndices(msgs);
        expect(turns).toHaveLength(2);
        expect(turns[0].index).toBe(0); // first user-text
        expect(turns[1].index).toBe(4); // second user-text
    });

    it('extracts preview text from user message', () => {
        const msgs: Message[] = [{
            kind: 'user-text',
            id: 'u1',
            localId: null,
            createdAt: 1000,
            text: 'Hello world',
        }];
        const turns = extractTurnIndices(msgs);
        expect(turns[0].preview).toBe('Hello world');
    });

    it('prefers displayText over text for preview', () => {
        const msgs: Message[] = [{
            kind: 'user-text',
            id: 'u1',
            localId: null,
            createdAt: 1000,
            text: 'raw text',
            displayText: 'Display version',
        }];
        const turns = extractTurnIndices(msgs);
        expect(turns[0].preview).toBe('Display version');
    });

    it('truncates preview to 60 chars', () => {
        const longText = 'A'.repeat(80);
        const msgs: Message[] = [{
            kind: 'user-text',
            id: 'u1',
            localId: null,
            createdAt: 1000,
            text: longText,
        }];
        const turns = extractTurnIndices(msgs);
        expect(turns[0].preview).toBe('A'.repeat(57) + '...');
        expect(turns[0].preview.length).toBe(60);
    });

    it('shows (empty) for empty text', () => {
        const msgs: Message[] = [{
            kind: 'user-text',
            id: 'u1',
            localId: null,
            createdAt: 1000,
            text: '',
        }];
        const turns = extractTurnIndices(msgs);
        expect(turns[0].preview).toBe('(empty)');
    });
});

// ============================================================================
// navigateTurn
// ============================================================================

describe('navigateTurn', () => {
    describe('empty turns', () => {
        it('returns null for any action on empty turns', () => {
            expect(navigateTurn([], null, 'prev')).toBeNull();
            expect(navigateTurn([], null, 'next')).toBeNull();
            expect(navigateTurn([], null, 'end')).toBeNull();
            expect(navigateTurn([], 0, 'prev')).toBeNull();
        });
    });

    describe('end action', () => {
        it('always returns null regardless of current position', () => {
            const turns = makeTurns(10);
            expect(navigateTurn(turns, null, 'end')).toBeNull();
            expect(navigateTurn(turns, 0, 'end')).toBeNull();
            expect(navigateTurn(turns, 5, 'end')).toBeNull();
            expect(navigateTurn(turns, 9, 'end')).toBeNull();
        });
    });

    describe('from bottom (selectedIdx = null)', () => {
        const turns = makeTurns(10);

        it('prev skips to second newest (index 1), not newest (index 0)', () => {
            expect(navigateTurn(turns, null, 'prev')).toBe(1);
        });

        it('prevPage skips PAGE_SIZE turns', () => {
            expect(navigateTurn(turns, null, 'prevPage')).toBe(PAGE_SIZE);
        });

        it('next stays at null (already at bottom)', () => {
            expect(navigateTurn(turns, null, 'next')).toBeNull();
        });

        it('nextPage stays at null', () => {
            expect(navigateTurn(turns, null, 'nextPage')).toBeNull();
        });
    });

    describe('from bottom with only 1 turn', () => {
        const turns = makeTurns(1);

        it('prev returns 0 (the only turn)', () => {
            expect(navigateTurn(turns, null, 'prev')).toBe(0);
        });

        it('prevPage returns 0 (clamped)', () => {
            expect(navigateTurn(turns, null, 'prevPage')).toBe(0);
        });
    });

    describe('step navigation (prev/next)', () => {
        const turns = makeTurns(5);

        it('prev increments index (goes to older turn)', () => {
            expect(navigateTurn(turns, 1, 'prev')).toBe(2);
        });

        it('prev clamps at oldest turn', () => {
            expect(navigateTurn(turns, 4, 'prev')).toBe(4);
        });

        it('next decrements index (goes to newer turn)', () => {
            expect(navigateTurn(turns, 2, 'next')).toBe(1);
        });

        it('next returns null when reaching bottom (index 0)', () => {
            expect(navigateTurn(turns, 0, 'next')).toBeNull();
        });
    });

    describe('page navigation (prevPage/nextPage)', () => {
        const turns = makeTurns(15);

        it('prevPage jumps PAGE_SIZE older', () => {
            expect(navigateTurn(turns, 2, 'prevPage')).toBe(2 + PAGE_SIZE);
        });

        it('prevPage clamps at oldest turn', () => {
            expect(navigateTurn(turns, 12, 'prevPage')).toBe(14);
        });

        it('nextPage jumps PAGE_SIZE newer', () => {
            expect(navigateTurn(turns, 8, 'nextPage')).toBe(8 - PAGE_SIZE);
        });

        it('nextPage returns null when overshooting bottom', () => {
            expect(navigateTurn(turns, 3, 'nextPage')).toBeNull();
        });
    });

    describe('full navigation sequence', () => {
        it('null → prev → prev → prev → next → next → next → null', () => {
            const turns = makeTurns(5);

            let pos: number | null = null;
            pos = navigateTurn(turns, pos, 'prev');   // null → 1
            expect(pos).toBe(1);

            pos = navigateTurn(turns, pos, 'prev');   // 1 → 2
            expect(pos).toBe(2);

            pos = navigateTurn(turns, pos, 'prev');   // 2 → 3
            expect(pos).toBe(3);

            pos = navigateTurn(turns, pos, 'next');   // 3 → 2
            expect(pos).toBe(2);

            pos = navigateTurn(turns, pos, 'next');   // 2 → 1
            expect(pos).toBe(1);

            pos = navigateTurn(turns, pos, 'next');   // 1 → 0
            expect(pos).toBe(0);

            pos = navigateTurn(turns, pos, 'next');   // 0 → null
            expect(pos).toBeNull();
        });
    });
});
