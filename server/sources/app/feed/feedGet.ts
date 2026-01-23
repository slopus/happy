import { Context } from "@/context";
import { FeedOptions, FeedResult } from "./types";
import type { Prisma } from "@prisma/client";
import { Tx } from "@/storage/inTx";

/**
 * Fetch user's feed with pagination.
 * Returns items in reverse chronological order (newest first).
 * Supports cursor-based pagination using the counter field.
 */
export async function feedGet(
    tx: Tx,
    ctx: Context,
    options?: FeedOptions
): Promise<FeedResult> {
    const limit = options?.limit ?? 100;
    const cursor = options?.cursor;

    // Build where clause for cursor pagination
    const where: Prisma.UserFeedItemWhereInput = { userId: ctx.uid };

    if (cursor?.before !== undefined) {
        if (cursor.before.startsWith('0-')) {
            where.counter = { lt: parseInt(cursor.before.substring(2), 10) };
        } else {
            throw new Error('Invalid cursor format');
        }
    } else if (cursor?.after !== undefined) {
        if (cursor.after.startsWith('0-')) {
            where.counter = { gt: parseInt(cursor.after.substring(2), 10) };
        } else {
            throw new Error('Invalid cursor format');
        }
    }

    // Fetch items + 1 to determine hasMore
    const items = await tx.userFeedItem.findMany({
        where,
        orderBy: { counter: 'desc' },
        take: limit + 1
    });

    // Check if there are more items
    const hasMore = items.length > limit;

    // Return only requested limit
    return {
        items: items.slice(0, limit).map(item => ({
            ...item,
            createdAt: item.createdAt.getTime(),
            cursor: '0-' + item.counter.toString(10)
        })),
        hasMore
    };
}
