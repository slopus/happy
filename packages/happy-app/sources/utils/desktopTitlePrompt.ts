import type { DisplayItem } from '@/hooks/useGroupedMessages';
import { deriveSessionFallbackTitle } from './sessionFallbackTitleText';

/**
 * The first prompt seeds a new session's fallback title. On desktop web the
 * title is already persistent in the header, so rendering the same prompt as
 * the first chat bubble repeats it directly underneath.
 */
export function getDesktopTitlePromptMessageId(
    displayItems: DisplayItem[],
    sessionTitle: string,
): string | null {
    for (let index = displayItems.length - 1; index >= 0; index -= 1) {
        const item = displayItems[index];
        if (item.type !== 'message' || item.message.kind !== 'user-text') {
            continue;
        }

        const fallbackTitle = deriveSessionFallbackTitle(item.message.displayText || item.message.text);
        return fallbackTitle === sessionTitle.trim() ? item.message.id : null;
    }

    return null;
}
