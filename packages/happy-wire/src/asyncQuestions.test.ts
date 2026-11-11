import { describe, expect, it } from 'vitest';
import { asyncQuestionActionSchema, getAsyncQuestions } from './asyncQuestions';
import { sessionTextEventSchema } from './sessionProtocol';

describe('optional async question metadata', () => {
    const questions = [{ title: 'Include screenshots?', options: ['Yes', 'No'] }];
    it('preserves structured options alongside readable text', () => {
        expect(sessionTextEventSchema.parse({ t: 'text', text: 'Include screenshots?\n- Yes\n- No', delivery: 'async', questions }).questions).toEqual(questions);
    });
    it('falls back to readable text for malformed rich metadata', () => {
        for (const questions of [[], [{ title: '' }], [{ title: 'Which?', options: [] }], [{ title: 'Which?', options: [''] }]]) {
            const parsed = sessionTextEventSchema.parse({ t: 'text', text: 'Keep me readable', delivery: 'async', questions });
            expect(parsed.text).toBe('Keep me readable');
            expect(getAsyncQuestions(parsed.delivery, parsed.questions)).toBeUndefined();
        }
    });
    it('does not infer a question from an ordinary list or submit an empty answer', () => {
        expect(getAsyncQuestions(undefined, questions)).toBeUndefined();
        expect(asyncQuestionActionSchema.safeParse({ action: 'answer', itemId: 'item', answers: [' '] }).success).toBe(false);
    });
});
