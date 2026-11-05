import { Usage } from '../api/types';

/**
 * Pricing rates per million tokens for different models, keyed by the model id
 * the API reports. `cache_write` is the 5-minute cache write rate.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (October 2026)
 */
export const PRICING = {
    // --- Claude 5 ---
    'claude-fable-5-1': {
        input: 10.0,
        output: 50.0,
        cache_write: 12.5,
        cache_read: 0.25
    },
    'claude-fable-5': {
        input: 10.0,
        output: 50.0,
        cache_write: 12.5,
        cache_read: 1.0
    },
    'claude-opus-5-5': {
        input: 4.0,
        output: 20.0,
        cache_write: 5.0,
        cache_read: 0.20
    },
    'claude-opus-5': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50
    },
    'claude-sonnet-5-5': {
        input: 2.0,
        output: 10.0,
        cache_write: 2.5,
        cache_read: 0.10
    },
    'claude-sonnet-5': {
        input: 2.0,
        output: 10.0,
        cache_write: 2.5,
        cache_read: 0.20
    },
    // Prompts up to 100K tokens. Above that the whole call is billed at 5x
    // (0.50 / 2.50 / 0.625 / 0.05), which this flat table cannot express.
    'claude-haiku-5-5': {
        input: 0.10,
        output: 0.50,
        cache_write: 0.125,
        cache_read: 0.01
    },

    // --- Claude 4 ---
    'claude-opus-4-8': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50
    },
    'claude-opus-4-7': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50
    },
    'claude-opus-4-6': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50
    },
    'claude-opus-4-5': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50
    },
    'claude-opus-4-1': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50
    },
    'claude-opus-4': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50
    },
    'claude-sonnet-4-6': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30
    },
    'claude-sonnet-4-5': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30
    },
    'claude-sonnet-4': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30
    },
    'claude-haiku-4-5': {
        input: 1.0,
        output: 5.0,
        cache_write: 1.25,
        cache_read: 0.10
    },

    // --- Legacy / Claude 3 ---
    'claude-3-opus-20240229': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.5
    },
    'claude-3-sonnet-20240229': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3
    },
    'claude-3-5-sonnet-20240620': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3
    },
    // New Sonnet 3.5 updated model
    'claude-3-5-sonnet-20241022': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3
    },
    'claude-3-haiku-20240307': {
        input: 0.25,
        output: 1.25,
        cache_write: 0.3125,
        cache_read: 0.025
    },
    'claude-3-5-haiku-20241022': {
        input: 0.8,
        output: 4.0,
        cache_write: 1.0,  // Approx based on 1.25x rule usually or custom
        cache_read: 0.08
    }
} as const;

export type ModelId = keyof typeof PRICING;

// Default to Sonnet 3.5 if unknown
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

/**
 * Calculate cost for usage
 * @param usage - Usage stats
 * @param modelId - Model ID (optional, defaults to Sonnet 3.5)
 */
export function calculateCost(usage: Usage, modelId?: string): { total: number, input: number, output: number } {
    // Besides the plain id (claude-opus-5-5), the id can carry a snapshot date
    // (claude-sonnet-4-5-20250929, Vertex: claude-opus-4-1@20250805), a
    // context-window suffix (claude-opus-5[1m]) or Bedrock's region prefix and
    // version (us.anthropic.claude-opus-4-1-20250805-v1:0). Strip those to find
    // the table key. Versions are never guessed from substrings: a model the
    // table doesn't know gets the default rates.
    const baseId = modelId
        ?.replace(/^([a-z]+\.)?anthropic\./, '')
        .replace(/(-v\d+:\d+|\[[^\]]*\])$/, '')
        .replace(/[-@]\d{8}$/, '');
    const pricing = PRICING[modelId as ModelId] ?? PRICING[baseId as ModelId] ?? PRICING[DEFAULT_MODEL];

    const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;

    // Cache costs
    const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cache_write;
    const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cache_read;

    const totalInputCost = inputCost + cacheWriteCost + cacheReadCost;

    return {
        total: totalInputCost + outputCost,
        input: totalInputCost,
        output: outputCost
    };
}
