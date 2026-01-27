import { z } from 'zod';

export const UsageSchema = z.object({
    // Usage statistics for assistant messages.
    // This is intentionally passthrough() to keep forward-compatible with new vendor fields.
    input_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative(),
    service_tier: z.string().optional(),
}).passthrough();

export type Usage = z.infer<typeof UsageSchema>;
