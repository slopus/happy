import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { selectVisibleTextPreviews } from './sessionTextPreviewProjection';

const preview = { sessionId: 's', turnId: 't', itemId: 'i', text: 'Partial', createdAt: 100 };
const final: Message = {
    kind: 'agent-text', id: 'durable', localId: null, createdAt: 200, text: 'Final',
    streamKey: { turnId: 't', itemId: 'i' },
};

describe('live text preview projection', () => {
    it('shows cumulative text in creation order without mutating the source snapshots', () => {
        const first = Object.freeze({ ...preview, itemId: 'first', createdAt: 10, text: 'First part' });
        const second = Object.freeze({ ...preview, itemId: 'second', createdAt: 20, text: 'Second part' });
        const snapshots = Object.freeze([second, first]);
        const result = selectVisibleTextPreviews('s', true, [], snapshots);
        expect(result.map(value => value.text)).toEqual(['First part', 'Second part']);
        expect(snapshots[0]).toBe(second);
        expect(result[0]).toBe(first);
    });

    it('never shows previews in an older history window or in a different session', () => {
        expect(selectVisibleTextPreviews('s', false, [], [preview])).toEqual([]);
        expect(selectVisibleTextPreviews('other-session', true, [], [preview])).toEqual([]);
    });

    it('hides a preview as soon as its exact durable item is visible, even before store cleanup', () => {
        expect(selectVisibleTextPreviews('s', true, [final], [preview])).toEqual([]);
    });

    it('does not hide a different item, turn, or legacy message with identical text', () => {
        const others: Message[] = [
            { ...final, streamKey: { turnId: 'other-turn', itemId: 'i' } },
            { ...final, streamKey: { turnId: 't', itemId: 'other-item' } },
            { ...final, streamKey: undefined, text: preview.text },
            { ...final, streamKey: { turnId: 't' } },
        ];
        expect(selectVisibleTextPreviews('s', true, others, [preview])).toEqual([preview]);
    });

    it('does not render empty whitespace or hide root output for a child tool response', () => {
        const child: Message = {
            kind: 'tool-call', id: 'tool', localId: null, createdAt: 50, children: [final],
            tool: { name: 'Task', state: 'running', input: {}, createdAt: 50,
                startedAt: 50, completedAt: null, description: null },
        };
        expect(selectVisibleTextPreviews('s', true, [child], [preview, { ...preview, itemId: 'blank', text: ' \n' }]))
            .toEqual([preview]);
    });
});
