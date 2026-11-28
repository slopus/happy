import { z } from 'zod';

export const AntigravityModelCatalogRequestSchema = z.object({ directory: z.string().min(1).max(4096) }).strict();
const option = z.object({
    code: z.string().min(1).max(512),
    value: z.string().min(1).max(1024),
    description: z.string().max(4096).nullable().optional(),
});
export const AntigravityModelCatalogSchema = z
    .object({
        source: z.literal('antigravity-native'),
        observedAt: z.number().finite().positive(),
        models: z
            .array(option.extend({ supportedEffortLevels: z.array(z.string().min(1).max(64)).max(32).optional() }))
            .max(1024),
        currentModelCode: z.string().min(1).max(512).optional(),
        thoughtLevels: z.array(option).max(32).optional(),
        currentThoughtLevelCode: z.string().min(1).max(64).optional(),
    })
    .superRefine((catalog, ctx) => {
        if (new Set(catalog.models.map((model) => model.code)).size !== catalog.models.length)
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate Antigravity model identifier' });
    });
export type AntigravityModelCatalog = z.infer<typeof AntigravityModelCatalogSchema>;
