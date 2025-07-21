import { describe, it, expect } from 'vitest';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';
import { createReducer } from './reducer';
import { reducer } from './reducer';

describe('reducer', () => {
    it('should process golden cases', () => {
        for (let i = 0; i <= 3; i++) {

            // Load raw data
            const raw = require(`./__testdata__/log_${i}.json`) as any[];
            const rawParsed = raw.map((v: any) => RawRecordSchema.parse(v.content));
            for (let i = 0; i < rawParsed.length; i++) {
                expect(rawParsed[i]).not.toBeNull();
            }
            expect(rawParsed, `raw_${i}`).toMatchSnapshot();

            const normalized = rawParsed.map((v: any, i) => normalizeRawMessage(`${i}`, null, 0, v));
            for (let i = 0; i < normalized.length; i++) {
                if (rawParsed[i].role === 'agent' && ((rawParsed[i] as any).content.data.type === 'system' || (rawParsed[i] as any).content.data.type === 'result')) {
                    continue;
                }
                expect(normalized[i]).not.toBeNull();
            }
            expect(normalized, `normalized_${i}`).toMatchSnapshot();

            const state = createReducer();
            const newMessages = reducer(state, normalized.filter(v => v !== null));
            expect(newMessages, `log_${i}`).toMatchSnapshot();
        }
    });
});