import { describe, it, expect } from 'vitest';
import { parseMessageAsEvent, isRateLimitMessage } from './messageToEvent';
import { NormalizedMessage } from '../typesRaw';

function createAgentTextMessage(text: string): NormalizedMessage {
    return {
        role: 'agent',
        content: [{ type: 'text', text }],
        id: 'test-id',
        localId: null,
        createdAt: Date.now(),
        isSidechain: false,
    } as NormalizedMessage;
}

describe('messageToEvent', () => {
    describe('parseMessageAsEvent', () => {
        it('parses Claude AI usage limit with timestamp', () => {
            const msg = createAgentTextMessage('Claude AI usage limit reached|1700000000');
            const event = parseMessageAsEvent(msg);
            expect(event).toEqual({
                type: 'limit-reached',
                endsAt: 1700000000,
            });
        });

        it('converts Gemini quota exceeded messages to limit-reached events', () => {
            const msg = createAgentTextMessage('Gemini quota exceeded. Quota resets in 3h20m. Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.');
            const event = parseMessageAsEvent(msg);
            expect(event).not.toBeNull();
            expect(event!.type).toBe('limit-reached');
            if (event!.type === 'limit-reached') {
                expect(event!.message).toContain('Gemini quota exceeded');
            }
        });

        it('converts rate limit exceeded messages to limit-reached events', () => {
            const msg = createAgentTextMessage('Gemini API rate limit exceeded. Please wait a moment and try again.');
            const event = parseMessageAsEvent(msg);
            expect(event).not.toBeNull();
            expect(event!.type).toBe('limit-reached');
        });

        it('does not convert regular agent messages', () => {
            const msg = createAgentTextMessage('Hello, how can I help you?');
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });

        it('skips sidechain messages', () => {
            const msg = {
                ...createAgentTextMessage('Claude AI usage limit reached|1700000000'),
                isSidechain: true,
            } as NormalizedMessage;
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });
    });

    describe('isRateLimitMessage', () => {
        it('detects "rate limit exceeded"', () => {
            expect(isRateLimitMessage('API rate limit exceeded')).toBe(true);
        });

        it('detects "quota exceeded"', () => {
            expect(isRateLimitMessage('Gemini quota exceeded.')).toBe(true);
        });

        it('detects "quota exhausted"', () => {
            expect(isRateLimitMessage('Your quota has been exhausted')).toBe(true);
        });

        it('detects "usage limit reached"', () => {
            expect(isRateLimitMessage('Usage limit reached for this account')).toBe(true);
        });

        it('detects "resource exhausted"', () => {
            expect(isRateLimitMessage('RESOURCE_EXHAUSTED: resource has been exhausted')).toBe(true);
        });

        it('detects "rate_limit_error"', () => {
            expect(isRateLimitMessage('Error: rate_limit_error on request')).toBe(true);
        });

        it('detects "rateLimitExceeded"', () => {
            expect(isRateLimitMessage('rateLimitExceeded for model')).toBe(true);
        });

        it('is case insensitive', () => {
            expect(isRateLimitMessage('RATE LIMIT EXCEEDED')).toBe(true);
            expect(isRateLimitMessage('Quota Exceeded')).toBe(true);
        });

        it('does not match regular messages', () => {
            expect(isRateLimitMessage('Hello world')).toBe(false);
            expect(isRateLimitMessage('The rate of change is high')).toBe(false);
            expect(isRateLimitMessage('This is a limited feature')).toBe(false);
        });
    });
});
