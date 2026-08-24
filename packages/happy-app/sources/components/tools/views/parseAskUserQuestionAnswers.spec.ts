import { describe, expect, it } from 'vitest';

import { parseAskUserQuestionResultAnswers } from './parseAskUserQuestionAnswers';

describe('parseAskUserQuestionResultAnswers', () => {
    it('maps canonical ordered answers back to question text', () => {
        expect(parseAskUserQuestionResultAnswers(
            JSON.stringify({ answers: ['In chat', 'Mobile'] }),
            ['Where?', 'Which client?'],
        )).toEqual({
            'Where?': 'In chat',
            'Which client?': 'Mobile',
        });
    });

    it('accepts the legacy object keyed by question text', () => {
        expect(parseAskUserQuestionResultAnswers({
            answers: { 'Where?': 'In chat' },
        }, ['Where?'])).toEqual({ 'Where?': 'In chat' });
    });

    it('ignores arbitrary tool results', () => {
        expect(parseAskUserQuestionResultAnswers('not json', ['Where?'])).toBeNull();
        expect(parseAskUserQuestionResultAnswers({ answer: 'wrong key' }, ['Where?'])).toBeNull();
    });
});