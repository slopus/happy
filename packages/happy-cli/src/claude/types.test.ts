import { describe, it, expect } from 'vitest'
import { RawJSONLinesSchema } from './types'

/**
 * Synthetic assistant message as written to the transcript when the API
 * rejects a turn (here: a 429 rate limit). Trimmed to the fields that matter;
 * note `usage.service_tier: null` — synthetic messages send null rather than
 * omitting the field.
 */
const syntheticRateLimitMessage = {
    parentUuid: '71437693-a340-47e8-a0a9-0923839462b5',
    isSidechain: false,
    type: 'assistant',
    uuid: 'e024081f-07a2-43db-93c0-6a9c45690060',
    timestamp: '2026-07-21T23:52:28.148Z',
    message: {
        id: 'a158ca6c-b9cb-44fa-92d2-8233fae10474',
        model: '<synthetic>',
        role: 'assistant',
        type: 'message',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: "You've hit your limit · resets Jul 23 at 6pm" }],
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            service_tier: null,
        },
    },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
}

describe('RawJSONLinesSchema', () => {
    it('accepts synthetic API-error messages that send usage.service_tier as null', () => {
        const result = RawJSONLinesSchema.safeParse(syntheticRateLimitMessage)
        expect(result.success).toBe(true)
    })

    it('keeps token counts when service_tier is null', () => {
        const result = RawJSONLinesSchema.parse(syntheticRateLimitMessage)
        expect(result.type).toBe('assistant')
        if (result.type !== 'assistant') return
        expect(result.message?.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 })
    })

    it('keeps the message when usage is malformed, dropping only usage', () => {
        const withBadUsage = {
            ...syntheticRateLimitMessage,
            message: { ...syntheticRateLimitMessage.message, usage: { input_tokens: 'lots' } },
        }
        const result = RawJSONLinesSchema.parse(withBadUsage)
        expect(result.type).toBe('assistant')
        if (result.type !== 'assistant') return
        expect(result.message?.usage).toBeUndefined()
    })

    it('still accepts a normal assistant message with a string service_tier', () => {
        const normal = {
            ...syntheticRateLimitMessage,
            error: undefined,
            isApiErrorMessage: undefined,
            message: {
                ...syntheticRateLimitMessage.message,
                model: 'claude-sonnet-4-5',
                usage: { input_tokens: 12, output_tokens: 34, service_tier: 'standard' },
            },
        }
        const result = RawJSONLinesSchema.parse(normal)
        expect(result.type).toBe('assistant')
        if (result.type !== 'assistant') return
        expect(result.message?.usage).toMatchObject({ service_tier: 'standard' })
    })
})
