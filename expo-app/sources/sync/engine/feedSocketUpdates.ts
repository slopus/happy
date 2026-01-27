import type { FeedItem } from '../feedTypes';

export async function handleNewFeedPostUpdate(params: {
    feedUpdate: {
        id: string;
        body: FeedItem['body'];
        cursor: string;
        createdAt: number;
        repeatKey?: string | null;
    };
    assumeUsers: (userIds: string[]) => Promise<void>;
    getUsers: () => Record<string, unknown>;
    applyFeedItems: (items: FeedItem[]) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { feedUpdate, assumeUsers, getUsers, applyFeedItems, log } = params;

    // Convert to FeedItem with counter from cursor
    const feedItem: FeedItem = {
        id: feedUpdate.id,
        body: feedUpdate.body,
        cursor: feedUpdate.cursor,
        createdAt: feedUpdate.createdAt,
        repeatKey: feedUpdate.repeatKey ?? null,
        counter: parseInt(feedUpdate.cursor.substring(2), 10),
    };

    // Check if we need to fetch user for friend-related items
    if (feedItem.body && (feedItem.body.kind === 'friend_request' || feedItem.body.kind === 'friend_accepted')) {
        await assumeUsers([feedItem.body.uid]);

        // Check if user fetch failed (404) - don't store item if user not found
        const users = getUsers();
        const userProfile = (users as Record<string, unknown>)[feedItem.body.uid];
        if (userProfile === null || userProfile === undefined) {
            // User was not found or 404, don't store this item
            log.log(`📰 Skipping feed item ${feedItem.id} - user ${feedItem.body.uid} not found`);
            return;
        }
    }

    // Apply to storage (will handle repeatKey replacement)
    applyFeedItems([feedItem]);
}
