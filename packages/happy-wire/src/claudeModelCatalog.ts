import { z } from 'zod';

export const ClaudeModelCatalogRequestSchema = z.object({
    directory: z.string().min(1).max(4096),
}).strict();

export const ClaudeModelOptionSchema = z.object({
    code: z.string().min(1).max(512),
    value: z.string().min(1).max(1024),
    supportedEffortLevels: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const ClaudeModelCatalogSchema = z.object({
    source: z.literal('claude-native'),
    observedAt: z.number().finite().positive(),
    models: z.array(ClaudeModelOptionSchema).min(1).max(1024),
});

export type ClaudeModelCatalog = z.infer<typeof ClaudeModelCatalogSchema>;
