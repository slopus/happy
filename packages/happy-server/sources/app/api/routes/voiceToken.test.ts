import { describe, expect, it } from 'vitest';
import { resolveVoiceConversationId } from './voiceToken';

describe('resolveVoiceConversationId', () => {
    it('prefers the conversation_id returned by the current API', () => {
        expect(resolveVoiceConversationId({
            token: 'not-a-jwt',
            conversation_id: 'conv_direct123',
        })).toBe('conv_direct123');
    });

    it('falls back to the LiveKit room in legacy JWTs', () => {
        const payload = Buffer.from(JSON.stringify({
            video: { room: 'prefix_conv_legacy456_suffix' },
        })).toString('base64url');

        expect(resolveVoiceConversationId({
            token: `header.${payload}.signature`,
        })).toBe('conv_legacy456');
    });

    it('returns null for malformed token responses', () => {
        expect(resolveVoiceConversationId({ token: 'invalid' })).toBeNull();
    });
});
