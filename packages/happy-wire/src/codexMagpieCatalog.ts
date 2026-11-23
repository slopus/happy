import { z } from 'zod';

export const CodexMagpieCatalogSchema = z.object({
    models: z.array(z.object({
        code: z.string().min(1),
        value: z.string().min(1),
        description: z.string().nullish(),
        supportedEffortLevels: z.array(z.string()),
        serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().nullish() })),
    })).min(1).max(1024),
    modelsUpdatedAt: z.number().finite().positive(),
}).nullable();

export type CodexMagpieCatalog = NonNullable<z.infer<typeof CodexMagpieCatalogSchema>>;
