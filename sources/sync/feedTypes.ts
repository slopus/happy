import { z } from 'zod';

// Feed body schema matching backend exactly
export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() })
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

// Feed item schema
export const FeedItemSchema = z.object({
    id: z.string(),
    repeatKey: z.string().nullable(),
    body: FeedBodySchema,
    createdAt: z.number(),
    cursor: z.string(),
    counter: z.number()
});

export type FeedItem = z.infer<typeof FeedItemSchema>;

// Feed response schema
export const FeedResponseSchema = z.object({
    items: z.array(z.object({
        id: z.string(),
        body: FeedBodySchema,
        repeatKey: z.string().nullable(),
        cursor: z.string(),
        createdAt: z.number()
    })),
    hasMore: z.boolean()
});

export type FeedResponse = z.infer<typeof FeedResponseSchema>;

// Feed options for API calls
export interface FeedOptions {
    limit?: number;
    before?: string;
    after?: string;
}