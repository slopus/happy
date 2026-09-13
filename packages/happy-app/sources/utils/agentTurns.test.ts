import { describe, expect, it } from 'vitest';
import { assignTurns } from './agentTurns';

// Rows are newest-first, as the chat holds them.
describe('assignTurns', () => {
    it('starts a new turn at every settled user message', () => {
        const turns = assignTurns([
            { kind: 'agent-text' },
            { kind: 'tool-call' },
            { kind: 'user-text' },
            { kind: 'agent-text' },
            { kind: 'user-text' },
        ]);

        expect(turns).toEqual([0, 0, 0, 1, 1]);
    });

    it('does not start a turn at a pending user message', () => {
        const turns = assignTurns([
            { kind: 'user-text', pending: true },
            { kind: 'agent-text' },
            { kind: 'user-text' },
        ]);

        expect(turns).toEqual([0, 0, 0]);
    });

    it('splits turns by turn id when the user message between them is missing', () => {
        // What the screenshot showed: the daemon dropped another participant's
        // message, so the previous answer sat directly under the new turn's work.
        const turns = assignTurns([
            { kind: 'agent-text', turn: 'B' },
            { kind: 'tool-call', turn: 'B' },
            { kind: 'agent-text', turn: 'A' },
            { kind: 'user-text' },
        ]);

        expect(turns).toEqual([0, 0, 1, 1]);
    });

    it('counts a turn once when both a user message and a turn id mark it', () => {
        const turns = assignTurns([
            { kind: 'agent-text', turn: 'B' },
            { kind: 'user-text' },
            { kind: 'agent-text', turn: 'A' },
            { kind: 'user-text' },
        ]);

        expect(turns).toEqual([0, 0, 1, 1]);
    });

    it('ignores rows without a turn id when comparing ids', () => {
        // Permission placeholders, receipts and rows from older daemons carry
        // none; they belong to whatever turn surrounds them.
        const turns = assignTurns([
            { kind: 'tool-call' },
            { kind: 'agent-text', turn: 'A' },
            { kind: 'agent-event' },
            { kind: 'tool-call', turn: 'A' },
        ]);

        expect(turns).toEqual([0, 0, 0, 0]);
    });

    it('keeps a pending message inside the turn it interrupted even with turn ids', () => {
        const turns = assignTurns([
            { kind: 'user-text', pending: true },
            { kind: 'agent-text', turn: 'A' },
            { kind: 'tool-call', turn: 'A' },
            { kind: 'user-text' },
        ]);

        expect(turns).toEqual([0, 0, 0, 0]);
    });

    it('does not compare a turn id across a user message boundary', () => {
        // The row after (older than) a user message opens a fresh comparison;
        // its id differing from the newer turn's id must not add a second turn.
        const turns = assignTurns([
            { kind: 'agent-text', turn: 'B' },
            { kind: 'user-text' },
            { kind: 'tool-call', turn: 'A' },
            { kind: 'agent-text', turn: 'A' },
        ]);

        expect(turns).toEqual([0, 0, 1, 1]);
    });
});
