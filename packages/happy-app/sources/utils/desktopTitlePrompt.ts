import type { DisplayItem } from '@/hooks/useGroupedMessages';

/**
 * The oldest user record is the desktop session's title prompt. Keep it out
 * of the conversation even when the persistent header title is renamed later.
 */
export function getDesktopTitlePromptMessageId(
    displayItems: DisplayItem[],
    isOldestPageLoaded: boolean,
): string | null {
    // Until the oldest page is loaded, the last visible item is only the
    // oldest item in the current window and may be a normal user message.
    if (!isOldestPageLoaded) return null;

    for (let index = displayItems.length - 1; index >= 0; index -= 1) {
        const item = displayItems[index];
        if (item.type !== 'message' || item.message.kind !== 'user-text') {
            continue;
        }

        return item.message.id;
    }

    return null;
}
