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

export async function handleTodoKvBatchUpdate(params: {
    kvUpdate: { changes?: unknown };
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateTodosSync: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { kvUpdate, applyTodoSocketUpdates, invalidateTodosSync, log } = params;

    // Process KV changes for todos
    if (kvUpdate.changes && Array.isArray(kvUpdate.changes)) {
        const todoChanges = kvUpdate.changes.filter(
            (change: any) => change.key && typeof change.key === 'string' && change.key.startsWith('todo.'),
        );

        if (todoChanges.length > 0) {
            log.log(`📝 Processing ${todoChanges.length} todo KV changes from socket`);

            // Apply the changes directly to avoid unnecessary refetch
            try {
                await applyTodoSocketUpdates(todoChanges);
            } catch (error) {
                console.error('Failed to apply todo socket updates:', error);
                // Fallback to refetch on error
                invalidateTodosSync();
            }
        }
    }
}

export function handleRelationshipUpdatedSocketUpdate(params: {
    relationshipUpdate: any;
    applyRelationshipUpdate: (update: any) => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
}): void {
    const { relationshipUpdate, applyRelationshipUpdate, invalidateFriends, invalidateFriendRequests, invalidateFeed } = params;

    // Apply the relationship update to storage
    applyRelationshipUpdate({
        fromUserId: relationshipUpdate.fromUserId,
        toUserId: relationshipUpdate.toUserId,
        status: relationshipUpdate.status,
        action: relationshipUpdate.action,
        fromUser: relationshipUpdate.fromUser,
        toUser: relationshipUpdate.toUser,
        timestamp: relationshipUpdate.timestamp,
    });

    // Invalidate friends data to refresh with latest changes
    invalidateFriends();
    invalidateFriendRequests();
    invalidateFeed();
}

