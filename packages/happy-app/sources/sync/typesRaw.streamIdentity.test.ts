import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, type RawRecord } from './typesRaw';

function normalize(ev: object, extra: object = {}) {
    return normalizeRawMessage('wire', null, 100, { role: 'session', content: { type: 'session', data: {
        id: 'envelope', time: 100, role: 'agent', turn: 'turn', codexItemId: 'item', ev, ...extra,
    } } } as RawRecord);
}
describe('stream identity on durable session messages', () => {
    it('retains exact root turn/item identity for final text reconciliation', () => {
        expect(normalize({ t: 'text', text: 'done' })?.streamKey).toEqual({ turnId: 'turn', itemId: 'item' });
    });
    it.each(['completed', 'failed', 'cancelled'])('retains terminal root turn for %s', status => {
        expect(normalize({ t: 'turn-end', status })?.streamKey).toEqual({ turnId: 'turn' });
    });
    it('does not let reasoning or user text close the assistant preview', () => {
        expect(normalize({ t: 'text', text: 'thinking', thinking: true })?.streamKey).toBeUndefined();
        expect(normalize({ t: 'text', text: 'user' }, { role: 'user' })?.streamKey).toBeUndefined();
    });
});
