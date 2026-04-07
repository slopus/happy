import * as z from 'zod';

export const VoiceTokenAllowedSchema = z.object({
    allowed: z.literal(true),
    signedUrl: z.string(),
    agentId: z.string(),
    elevenUserId: z.string(),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
});

export const VoiceTokenDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_hard_limit_reached', 'subscription_required']),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    agentId: z.string(),
});

export const VoiceTokenResponseSchema = z.discriminatedUnion('allowed', [
    VoiceTokenAllowedSchema,
    VoiceTokenDeniedSchema,
]);

export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponseSchema>;

export const VoiceUsageResponseSchema = z.object({
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    elevenUserId: z.string(),
});

export type VoiceUsageResponse = z.infer<typeof VoiceUsageResponseSchema>;
