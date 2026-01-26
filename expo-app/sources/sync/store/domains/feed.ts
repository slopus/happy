import type { FeedItem } from '../../feedTypes';
import type { StoreGet, StoreSet } from './_shared';

export type FeedDomain = {
  feedItems: FeedItem[];
  feedHead: string | null;
  feedTail: string | null;
  feedHasMore: boolean;
  feedLoaded: boolean;
  applyFeedItems: (items: FeedItem[]) => void;
  clearFeed: () => void;
};

export function createFeedDomain<S extends FeedDomain & { friendsLoaded: boolean }>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): FeedDomain {
  return {
    feedItems: [],
    feedHead: null,
    feedTail: null,
    feedHasMore: false,
    feedLoaded: false,
    applyFeedItems: (items) =>
      set((state) => {
        // Always mark feed as loaded even if empty
        if (items.length === 0) {
          return {
            ...state,
            feedLoaded: true, // Mark as loaded even when empty
          };
        }

        // Create a map of existing items for quick lookup
        const existingMap = new Map<string, FeedItem>();
        state.feedItems.forEach((item) => {
          existingMap.set(item.id, item);
        });

        // Process new items
        const updatedItems = [...state.feedItems];
        let head = state.feedHead;
        let tail = state.feedTail;

        items.forEach((newItem) => {
          // Remove items with same repeatKey if it exists
          if (newItem.repeatKey) {
            const indexToRemove = updatedItems.findIndex((item) => item.repeatKey === newItem.repeatKey);
            if (indexToRemove !== -1) {
              updatedItems.splice(indexToRemove, 1);
            }
          }

          // Add new item if it doesn't exist
          if (!existingMap.has(newItem.id)) {
            updatedItems.push(newItem);
          }

          // Update head/tail cursors
          if (!head || newItem.counter > parseInt(head.substring(2), 10)) {
            head = newItem.cursor;
          }
          if (!tail || newItem.counter < parseInt(tail.substring(2), 10)) {
            tail = newItem.cursor;
          }
        });

        // Sort by counter (desc - newest first)
        updatedItems.sort((a, b) => b.counter - a.counter);

        return {
          ...state,
          feedItems: updatedItems,
          feedHead: head,
          feedTail: tail,
          feedLoaded: true, // Mark as loaded after first fetch
        };
      }),
    clearFeed: () =>
      set((state) => ({
        ...state,
        feedItems: [],
        feedHead: null,
        feedTail: null,
        feedHasMore: false,
        feedLoaded: false, // Reset loading flag
        friendsLoaded: false, // Reset loading flag
      })),
  };
}

