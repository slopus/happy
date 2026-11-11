import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, type RawRecord } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import { MetadataSchema } from './storageTypes';

const questions = [{ title: 'Screenshots?', options: ['Yes', 'No'] }];
function raw(extra: object = {}, ev: object = {}): RawRecord {
    return { role: 'session', content: { type: 'session', data: {
        id: 'envelope', time: 100, role: 'agent', turn: 'turn', codexItemId: 'call-question',
        ev: { t: 'text', text: 'Screenshots?\n- Yes\n- No', delivery: 'async', questions, ...ev }, ...extra,
    } } } as RawRecord;
}
describe('asynchronous questions through persisted message projection', () => {
    it('retains structured questions through parse, normalization, reduction and reload', () => {
        const normalized = normalizeRawMessage('wire', null, 100, JSON.parse(JSON.stringify(raw())))!;
        const rendered = reducer(createReducer(), [normalized]).messages[0];
        expect(rendered).toMatchObject({ kind: 'agent-text', asyncQuestion: { id: 'call-question', questions } });
        const replayed = reducer(createReducer(), [JSON.parse(JSON.stringify(normalized))]).messages[0];
        expect(replayed).toMatchObject({ asyncQuestion: { id: 'call-question', questions } });
    });
    it('keeps child, user, malformed and plain text readable without active question controls', () => {
        for (const record of [raw({ subagent: createId() }), raw({ role: 'user' }), raw({}, { questions: [{ title: '' }] }), raw({}, { delivery: undefined }), raw({}, { thinking: true })]) {
            const normalized = normalizeRawMessage('wire', null, 100, record)!;
            expect(normalized).toBeTruthy();
            expect(normalized.asyncQuestion).toBeUndefined();
        }
    });
    it('preserves answered and skipped receipts in encrypted session metadata', () => {
        const responses = { a: { status: 'answered', answers: ['No'], updatedAt: 12 }, b: { status: 'dismissed', updatedAt: 13 } };
        expect(MetadataSchema.parse({ path: '/project', host: 'machine', codexAsyncQuestionResponses: responses,
            capabilities: { codexAsyncQuestions: true } })).toMatchObject({ codexAsyncQuestionResponses: responses, capabilities: { codexAsyncQuestions: true } });
    });
});
