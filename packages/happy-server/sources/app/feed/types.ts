import * as z from "zod";

export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() })
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

export interface UserFeedItem {
    id: string;
    userId: string;
    repeatKey: string | null;
    body: FeedBody;
    createdAt: number;
    cursor: string;
}

export interface FeedCursor {
    before?: string;
    after?: string;
}

export interface FeedOptions {
    limit?: number;
    cursor?: FeedCursor;
}

export interface FeedResult {
    items: UserFeedItem[];
    hasMore: boolean;
}