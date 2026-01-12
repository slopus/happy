import { useState, useCallback, useRef } from 'react';
import { storage } from '@/sync/storage';

/**
 * Hook for navigating through user message history across all sessions.
 * Provides arrow key navigation similar to shell history or Claude Code.
 *
 * Usage:
 * - navigateUp(currentDraft): Get previous message in history, preserving current draft
 * - navigateDown(): Get next message in history (or saved draft when returning to end)
 * - reset(): Reset to end of history (no selection)
 *
 * The hook preserves the current input text as a "draft" when first navigating up,
 * and restores it when navigating back down past all history.
 */
export function useUserMessageHistory() {
    const [historyIndex, setHistoryIndex] = useState(-1);
    const savedDraft = useRef<string>('');

    // Build history from all sessions, sorted by timestamp (most recent first)
    // This is called on-demand rather than memoized to avoid stale data
    const getHistory = useCallback(() => {
        const allSessions = storage.getState().sessions;
        const allSessionMessages = storage.getState().sessionMessages;
        const userMessages: Array<{ text: string; time: number }> = [];

        // Collect all user messages from all sessions
        for (const sessionId in allSessions) {
            const sessionMessages = allSessionMessages[sessionId];
            if (!sessionMessages?.messages) continue;

            for (const msg of sessionMessages.messages) {
                if (msg.kind === 'user-text') {
                    userMessages.push({
                        text: msg.text,
                        time: msg.createdAt
                    });
                }
            }
        }

        // Sort by timestamp descending (most recent first)
        userMessages.sort((a, b) => b.time - a.time);

        return userMessages.map(m => m.text);
    }, []);

    /**
     * Navigate to previous message in history (older)
     * Returns the message text or null if at end of history
     *
     * @param currentDraft - The current input text to preserve as draft
     */
    const navigateUp = useCallback((currentDraft?: string) => {
        const history = getHistory();

        // Save draft when first navigating into history
        if (historyIndex === -1 && currentDraft !== undefined) {
            savedDraft.current = currentDraft;
        }

        if (historyIndex < history.length - 1) {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            return history[newIndex];
        }
        return null;
    }, [historyIndex, getHistory]);

    /**
     * Navigate to next message in history (newer)
     * Returns the message text, saved draft when returning to end, or null if already at end
     */
    const navigateDown = useCallback(() => {
        const history = getHistory();

        if (historyIndex > -1) {
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);

            // Return saved draft when navigating back past all history
            if (newIndex === -1) {
                const draft = savedDraft.current;
                savedDraft.current = ''; // Clear saved draft
                return draft;
            }

            return history[newIndex];
        }
        return null;
    }, [historyIndex, getHistory]);

    /**
     * Reset history navigation to end (no selection)
     * Clears saved draft
     */
    const reset = useCallback(() => {
        setHistoryIndex(-1);
        savedDraft.current = '';
    }, []);

    return {
        navigateUp,
        navigateDown,
        reset,
        isNavigating: historyIndex !== -1
    };
}
