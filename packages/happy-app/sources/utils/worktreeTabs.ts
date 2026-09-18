import type { SessionRowData } from '@/sync/storage';
import type { PendingChat } from '@/sync/pendingChats';

export interface WorktreeTabs {
    /** The checkout's real chats, in tab order. */
    tabs: SessionRowData[];
    /** The stand-ins for chats that do not have a name yet. */
    pending: PendingChat[];
}

/**
 * Which tabs a checkout's strip draws while chats are being opened in it.
 *
 * One chat is one tab, and a chat being started is briefly two things at once:
 * the stand-in the user is already typing in, and — from the moment the server
 * announces it — a row in the session list. Drawing both is what put the same
 * new chat in the strip twice and then made one of them vanish.
 *
 * The two cannot be matched by name, because the name is what is missing: the
 * `new-session` push beats the daemon's reply, and until that reply lands
 * nothing on the client knows which row belongs to which request. What is known
 * is which chats were in the checkout when the user pressed `+`, so a row that
 * was not among them is the arrival the stand-in is already standing in for,
 * and it waits its turn rather than doubling it.
 *
 * Nothing is claimed in the routing sense: an unrelated chat opened elsewhere
 * in the same checkout at the same moment is only delayed by the second or so
 * the start takes, never opened, never written to.
 */
/**
 * The tab that takes over the screen when `sessionId` leaves the strip: the one
 * to its left, or — for the first tab, which has nothing to its left — the one
 * to its right. The same choice closing a tab makes anywhere else.
 *
 * Has to be asked before the chat goes, not after: archiving takes it out of
 * the checkout, and a checkout looked up through a chat that is no longer in it
 * comes back empty.
 */
export function neighbouringTabId(
    tabs: readonly SessionRowData[],
    sessionId: string,
): string | null {
    const index = tabs.findIndex((tab) => tab.id === sessionId);
    if (index === -1) return null;
    return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null;
}

export function resolveWorktreeTabs({ tabs, pending }: {
    tabs: readonly SessionRowData[];
    /** Oldest first, so concurrent starts take arrivals in the order asked. */
    pending: readonly PendingChat[];
}): WorktreeTabs {
    if (pending.length === 0) {
        return { tabs: [...tabs], pending: [] };
    }

    const spokenFor = new Set<string>();
    const visible: PendingChat[] = [];

    for (const chat of pending) {
        // Named, and therefore finished: the session is the tab from here on.
        // A stand-in is never drawn for one, not even when the list has stopped
        // carrying it — the list dropping a chat is archiving, and a chip that
        // came back to stand for an archived chat is exactly the ghost that put
        // an unopenable third tab in the strip.
        if (chat.sessionId) continue;

        const arrival = tabs.find((tab) => (
            !spokenFor.has(tab.id) && !chat.knownSessionIds.includes(tab.id)
        ));
        if (arrival) spokenFor.add(arrival.id);
        visible.push(chat);
    }

    return {
        tabs: tabs.filter((tab) => !spokenFor.has(tab.id)),
        pending: visible,
    };
}
