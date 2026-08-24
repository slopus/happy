import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { parseRawRequestUserInputQuestions } from './parseRawRequestUserInputQuestions';

describe('parseRawRequestUserInputQuestions', () => {
    it('reads the normal shape: options as an array of { label, description }', () => {
        const questions = parseRawRequestUserInputQuestions({
            questions: [{
                header: 'Storage',
                question: 'Where should it live?',
                options: [
                    { label: 'Settings', description: 'Synced' },
                    { label: 'Locally' },
                ],
                multiSelect: false,
            }],
        });

        expect(questions).toHaveLength(1);
        expect(questions[0]).toMatchObject({
            header: 'Storage',
            question: 'Where should it live?',
            options: [
                { label: 'Settings', description: 'Synced' },
                { label: 'Locally', description: null },
            ],
            multiSelect: false,
        });
    });

    it('unwraps a { choices, multiSelect } wrapper used in place of the options array', () => {
        const questions = parseRawRequestUserInputQuestions({
            questions: [{
                header: 'Scope',
                question: 'Which surfaces?',
                options: { choices: ['Mobile', 'Desktop'], multiSelect: true },
            }],
        });

        expect(questions[0].options).toEqual([{ label: 'Mobile' }, { label: 'Desktop' }]);
        expect(questions[0].multiSelect).toBe(true);
    });

    it('unwraps the malformed shape where the wrapper is the array\'s lone element', () => {
        // The exact shape seen in the archaeology incident: options[0] was
        // { choices, multiSelect } instead of a real option.
        const questions = parseRawRequestUserInputQuestions({
            questions: [{
                header: 'Migration gate plan',
                question: 'Proceed?',
                options: [{ choices: ['Yes', 'No'], multiSelect: false }],
            }],
        });

        expect(questions[0].options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
        expect(questions[0].multiSelect).toBe(false);
    });

    it('prefers an explicit multiSelect on the question over the wrapper\'s', () => {
        const questions = parseRawRequestUserInputQuestions({
            questions: [{
                header: 'Scope',
                question: 'Which surfaces?',
                options: { choices: ['Mobile'], multiSelect: true },
                multiSelect: false,
            }],
        });

        expect(questions[0].multiSelect).toBe(false);
    });

    it('accepts a single top-level question object without a questions array', () => {
        const questions = parseRawRequestUserInputQuestions({
            header: 'Confirm',
            question: 'Proceed?',
            options: [{ label: 'Yes' }],
        });

        expect(questions).toHaveLength(1);
        expect(questions[0].question).toBe('Proceed?');
    });

    it('accepts an { input: {...} } wrapper around the questions payload', () => {
        const questions = parseRawRequestUserInputQuestions({
            input: { questions: [{ header: 'X', question: 'Y?', options: [{ label: 'Z' }] }] },
        });

        expect(questions).toHaveLength(1);
    });

    it('drops a question with no question text rather than throwing', () => {
        const questions = parseRawRequestUserInputQuestions({
            questions: [{ header: 'X', options: [{ label: 'Z' }] }],
        });

        expect(questions).toEqual([]);
    });

    it('returns an empty list for garbage input', () => {
        expect(parseRawRequestUserInputQuestions(null)).toEqual([]);
        expect(parseRawRequestUserInputQuestions(undefined)).toEqual([]);
        expect(parseRawRequestUserInputQuestions('not an object')).toEqual([]);
        expect(parseRawRequestUserInputQuestions({ questions: 'not an array' })).toEqual([]);
    });

    it('drops non-string entries inside choices/options instead of crashing', () => {
        const questions = parseRawRequestUserInputQuestions({
            questions: [{
                header: 'X',
                question: 'Y?',
                options: [{ label: 'Good' }, { notLabel: 'bad' }, null, 42],
            }],
        });

        expect(questions[0].options).toEqual([{ label: 'Good', description: null }]);
    });
});
