import * as z from 'zod';

export const VoiceConversationGrantedSchema = z.object({
    allowed: z.literal(true),
    signedUrl: z.string(),
    conversationId: z.string(),
    agentId: z.string(),
    elevenUserId: z.string(),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
});

export const VoiceConversationDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_hard_limit_reached', 'subscription_required']),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    agentId: z.string(),
});

export const VoiceConversationResponseSchema = z.discriminatedUnion('allowed', [
    VoiceConversationGrantedSchema,
    VoiceConversationDeniedSchema,
]);

export type VoiceConversationResponse = z.infer<typeof VoiceConversationResponseSchema>;

export const VoiceUsageResponseSchema = z.object({
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    elevenUserId: z.string(),
});

export type VoiceUsageResponse = z.infer<typeof VoiceUsageResponseSchema>;
