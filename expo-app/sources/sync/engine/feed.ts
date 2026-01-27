import type { FeedItem } from '../feedTypes';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { UserProfile } from '../friendTypes';
import { fetchFeed as fetchFeedApi } from '../apiFeed';

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

export async function fetchAndApplyFeed(params: {
    credentials: AuthCredentials;
    getFeedItems: () => FeedItem[];
    getFeedHead: () => string | null;
    assumeUsers: (userIds: string[]) => Promise<void>;
    getUsers: () => Record<string, UserProfile | null>;
    applyFeedItems: (items: FeedItem[]) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, getFeedItems, getFeedHead, assumeUsers, getUsers, applyFeedItems, log } = params;

    try {
        log.log('📰 Fetching feed...');
        const existingItems = getFeedItems();
        const head = getFeedHead();

        // Load feed items - if we have a head, load newer items
        const allItems: FeedItem[] = [];
        let hasMore = true;
        let cursor = head ? { after: head } : undefined;
        let loadedCount = 0;
        const maxItems = 500;

        // Keep loading until we reach known items or hit max limit
        while (hasMore && loadedCount < maxItems) {
            const response = await fetchFeedApi(credentials, {
                limit: 100,
                ...cursor,
            });

            // Check if we reached known items
            const foundKnown = response.items.some((item) => existingItems.some((existing) => existing.id === item.id));

            allItems.push(...response.items);
            loadedCount += response.items.length;
            hasMore = response.hasMore && !foundKnown;

            // Update cursor for next page
            if (response.items.length > 0) {
                const lastItem = response.items[response.items.length - 1];
                cursor = { after: lastItem.cursor };
            }
        }

        // If this is initial load (no head), also load older items
        if (!head && allItems.length < 100) {
            const response = await fetchFeedApi(credentials, {
                limit: 100,
            });
            allItems.push(...response.items);
        }

        // Collect user IDs from friend-related feed items
        const userIds = new Set<string>();
        allItems.forEach((item) => {
            if (item.body && (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')) {
                userIds.add(item.body.uid);
            }
        });

        // Fetch missing users
        if (userIds.size > 0) {
            await assumeUsers(Array.from(userIds));
        }

        // Filter out items where user is not found (404)
        const users = getUsers();
        const compatibleItems = allItems.filter((item) => {
            // Keep text items
            if (item.body.kind === 'text') return true;

            // For friend-related items, check if user exists and is not null (404)
            if (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted') {
                const userProfile = users[item.body.uid];
                // Keep item only if user exists and is not null
                return userProfile !== null && userProfile !== undefined;
            }

            return true;
        });

        // Apply only compatible items to storage
        applyFeedItems(compatibleItems);
        log.log(
            `📰 fetchFeed completed - loaded ${compatibleItems.length} compatible items (${allItems.length - compatibleItems.length} filtered)`,
        );
    } catch (error) {
        console.error('Failed to fetch feed:', error);
    }
}
