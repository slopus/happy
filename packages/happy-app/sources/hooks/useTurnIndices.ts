import { useMemo } from 'react';
import { Message } from '@/sync/typesMessage';

export const PAGE_SIZE = 5;

export interface TurnInfo {
    /** Index in the FlatList data array (inverted: 0 = newest) */
    index: number;
    /** Turn number, 1-based, oldest = 1 */
    turnNumber: number;
    /** Message ID of the user-text message that starts this turn */
    messageId: string;
    /** First ~60 chars of the user-text message for preview in turn picker */
    preview: string;
}

export type NavigateAction = 'prev' | 'next' | 'prevPage' | 'nextPage' | 'end';

/**
 * Extract turn boundaries from a Message array.
 *
 * In an inverted FlatList the data array is ordered newest-first
 * (index 0 = bottom of screen). A "turn" starts at every
 * `kind === 'user-text'` message. Turn numbers are assigned
 * oldest = 1, newest = N so they feel natural to the user.
 */
/**
 * Extract turn boundaries from a Message array.
 *
 * In an inverted FlatList the data array is ordered newest-first
 * (index 0 = bottom of screen). A "turn" starts at every
 * `kind === 'user-text'` message. Turn numbers are assigned
 * oldest = 1, newest = N so they feel natural to the user.
 */
export function extractTurnIndices(messages: Message[]): TurnInfo[] {
    const rawIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].kind === 'user-text') {
            rawIndices.push(i);
        }
    }

    const total = rawIndices.length;
    return rawIndices.map((index, i) => {
        const msg = messages[index];
        let text = '';
        if (msg.kind === 'user-text') {
            text = (msg.displayText || msg.text || '').trim();
        }
        const preview = text.length > 60
            ? text.slice(0, 57) + '...'
            : text || '(empty)';
        return {
            index,
            turnNumber: total - i,
            messageId: msg.id,
            preview,
        };
    });
}

export function useTurnIndices(messages: Message[]): TurnInfo[] {
    return useMemo(() => extractTurnIndices(messages), [messages]);
}

/**
 * Given the current selected position in the turns array,
 * compute the next position after applying `action`.
 *
 * `selectedIdx` is an index into the `turns` array (NOT the
 * FlatList data index). `null` means "at the bottom / latest".
 *
 * Returns the new turns-array index, or `null` for "go to end".
 */
export function navigateTurn(
    turns: TurnInfo[],
    selectedIdx: number | null,
    action: NavigateAction,
): number | null {
    if (turns.length === 0) return null;

    // "end" always returns null (= latest / bottom)
    if (action === 'end') return null;

    // Resolve current position.
    // null (at bottom) means "already viewing the latest turn" —
    // prev should skip to the SECOND newest (index 1), not the newest (index 0)
    // which is already visible. next/nextPage stay at null.
    if (selectedIdx === null) {
        if (action === 'next' || action === 'nextPage') return null;
        if (action === 'prev') return turns.length > 1 ? 1 : 0;
        // prevPage: skip PAGE_SIZE turns from the latest
        return Math.min(PAGE_SIZE, turns.length - 1);
    }

    switch (action) {
        // In the turns array index 0 = newest, higher = older.
        // "prev" = go to an older turn = higher index.
        case 'prev':
            return Math.min(selectedIdx + 1, turns.length - 1);
        case 'next': {
            const next = selectedIdx - 1;
            return next < 0 ? null : next;
        }
        case 'prevPage':
            return Math.min(selectedIdx + PAGE_SIZE, turns.length - 1);
        case 'nextPage': {
            const next = selectedIdx - PAGE_SIZE;
            return next < 0 ? null : next;
        }
    }
}
