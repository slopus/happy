import { describe, it, expect } from 'vitest';
import { calculateCost } from './pricing';

// One million input and output tokens, so the totals read as $/MTok rates.
const MTOK = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe('calculateCost', () => {
    it.each([
        ['claude-fable-5-1', 10, 50],
        ['claude-fable-5', 10, 50],
        ['claude-opus-5-5', 4, 20],
        ['claude-opus-5', 5, 25],
        ['claude-sonnet-5-5', 2, 10],
        ['claude-sonnet-5', 2, 10],
        ['claude-haiku-5-5', 0.1, 0.5],
        ['claude-opus-4-8', 5, 25],
        ['claude-opus-4-7', 5, 25],
        ['claude-opus-4-6', 5, 25],
        ['claude-opus-4-5', 5, 25],
        ['claude-opus-4-1', 15, 75],
        ['claude-opus-4', 15, 75],
        ['claude-sonnet-4-6', 3, 15],
        ['claude-sonnet-4-5', 3, 15],
        ['claude-sonnet-4', 3, 15],
        ['claude-haiku-4-5', 1, 5],
    ])('prices %s at its own rates', (model, input, output) => {
        const cost = calculateCost(MTOK, model);
        expect(cost.input).toBeCloseTo(input);
        expect(cost.output).toBeCloseTo(output);
    });

    it('does not price Claude 5 Opus as Claude 3 Opus', () => {
        expect(calculateCost(MTOK, 'claude-opus-5-5').total).toBeCloseTo(24);
        expect(calculateCost(MTOK, 'claude-opus-5').total).toBeCloseTo(30);
    });

    it.each([
        ['claude-opus-4-1-20250805', 15, 75],
        ['claude-opus-4-20250514', 15, 75],
        ['claude-sonnet-4-5-20250929', 3, 15],
        ['claude-haiku-4-5-20251001', 1, 5],
        ['claude-opus-5[1m]', 5, 25],
        ['claude-opus-4-1@20250805', 15, 75],
        ['us.anthropic.claude-opus-4-1-20250805-v1:0', 15, 75],
        ['anthropic.claude-opus-5-5', 4, 20],
    ])('resolves the provider form %s to its base model', (model, input, output) => {
        const cost = calculateCost(MTOK, model);
        expect(cost.input).toBeCloseTo(input);
        expect(cost.output).toBeCloseTo(output);
    });

    it('keeps exact matches for dated Claude 3 ids', () => {
        const cost = calculateCost(MTOK, 'claude-3-haiku-20240307');
        expect(cost.input).toBeCloseTo(0.25);
        expect(cost.output).toBeCloseTo(1.25);
    });

    it('uses each model\'s own cache rates', () => {
        const cost = calculateCost({
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
        }, 'claude-opus-5-5');
        expect(cost.input).toBeCloseTo(5 + 0.2);
        expect(cost.output).toBe(0);
    });

    it('falls back to the default rates for unknown or missing models', () => {
        for (const model of ['claude-opus-14', 'some-other-model', undefined]) {
            const cost = calculateCost(MTOK, model);
            expect(cost.input).toBeCloseTo(3);
            expect(cost.output).toBeCloseTo(15);
        }
    });
});
