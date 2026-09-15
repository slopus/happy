import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('durable text identity for live preview reconciliation', () => {
    it('keeps the provider turn and item identity on the rendered final text', () => {
        const message: NormalizedMessage = {
            id: 'wire-final', localId: null, createdAt: 100, role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: 'Final answer', uuid: 'wire-final', parentUUID: null }],
            streamKey: { turnId: 'turn-a', itemId: 'item-a' },
        };
        const result = reducer(createReducer(), [message]);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toMatchObject({ kind: 'agent-text', text: 'Final answer',
            streamKey: { turnId: 'turn-a', itemId: 'item-a' } });
    });

    it('does not assign a text identity to thinking blocks or legacy text', () => {
        const message: NormalizedMessage = {
            id: 'wire-mixed', localId: null, createdAt: 100, role: 'agent', isSidechain: false,
            content: [{ type: 'thinking', thinking: 'Private reasoning', uuid: 'reasoning', parentUUID: null }],
            streamKey: { turnId: 'turn-a', itemId: 'item-a' },
        };
        const legacy: NormalizedMessage = {
            id: 'wire-legacy', localId: null, createdAt: 200, role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: 'Legacy answer', uuid: 'legacy', parentUUID: null }],
        };
        const result = reducer(createReducer(), [message, legacy]);
        expect(result.messages).toHaveLength(2);
        for (const rendered of result.messages) expect(rendered).not.toHaveProperty('streamKey');
    });
});
