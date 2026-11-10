import { z } from 'zod';

/** Predictions are auxiliary RPC results, never user messages or saved drafts. */
export const ComposerPredictionRequestSchema = z.object({
    requestId: z.string().min(1).max(128),
    sourceTurnId: z.string().min(1).max(512),
}).strict();
export type ComposerPredictionRequest = z.infer<typeof ComposerPredictionRequestSchema>;

export const ComposerPredictionCancelSchema = ComposerPredictionRequestSchema.pick({ requestId: true });
export const ComposerPredictionResponseSchema = z.object({
    sourceTurnId: z.string(),
    status: z.enum(['ready', 'none', 'unsupported', 'stale', 'failed']),
    text: z.string().min(1).max(240).optional(),
});
export type ComposerPredictionResponse = z.infer<typeof ComposerPredictionResponseSchema>;
