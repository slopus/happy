import { getPendingChat, settlePendingChat } from '@/sync/pendingChats';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Moving what was typed into a chat that did not exist yet onto the one that
 * now does.
 *
 * Kept apart from the store so `pendingChats` stays a store — and apart from
 * the screen because the screen is the wrong owner: a stand-in can be typed in,
 * left for a sibling tab, and answered by the machine while nothing is drawing
 * it. The text still has to arrive.
 */

/**
 * The machine answered. From here the chat is real, and whatever was typed into
 * the stand-in belongs to it: as its first message if send was already pressed,
 * as its draft if it was not.
 *
 * The session exists in the store by now — `startSession` syncs the list before
 * it reports the id — so the draft has somewhere to be written, and the real
 * composer hydrates from it synchronously when it mounts.
 */
export function handOverPendingChat(id: string, sessionId: string): void {
    const chat = getPendingChat(id);
    if (!chat) {
        settlePendingChat(id, sessionId);
        return;
    }

    // Everything below happens before the settle, and therefore before the
    // screen reacts to it by routing to the real chat: the composer that mounts
    // there hydrates its draft synchronously, so a draft written afterwards
    // would arrive to a field that has already read an empty one.

    // Anything still being written is the new chat's draft, and the real
    // composer hydrates from it when it mounts a moment from now.
    if (chat.draft.trim()) {
        storage.getState().updateSessionDraft(sessionId, chat.draft);
    }

    // Messages already sent go out from here rather than from the arriving
    // screen, which may not be mounted yet — or ever, if the user has moved on
    // to a sibling tab in the meantime. Awaited one after another so they reach
    // the agent in the order they were written.
    void chat.queued.reduce(
        (previous, message) => previous.then(() => sync.sendMessage(
            sessionId,
            message.trim(),
            { source: 'new_session' },
        )),
        Promise.resolve() as Promise<unknown>,
    ).catch((error) => {
        Modal.alert(
            t('common.error'),
            error instanceof Error ? error.message : 'Failed to send the first message',
        );
    });

    settlePendingChat(id, sessionId);
}

/**
 * The start is not coming. The tab goes, but the writing does not: it is put
 * back on the chat the stand-in was opened beside, which is where the screen is
 * about to return to. Messages that were sent count as writing here — nothing
 * ever received them, so they are text the user still has.
 *
 * Only onto an empty composer. A draft already sitting on the anchor is the
 * user's other unfinished thought, and this one is not worth overwriting it.
 */
export function returnPendingChatDraft(id: string): void {
    const chat = getPendingChat(id);
    if (!chat) return;
    const text = [...chat.queued, chat.draft].filter((part) => part.trim()).join('\n\n');
    if (!text) return;
    const anchor = storage.getState().sessions[chat.anchorSessionId];
    if (!anchor || anchor.draft?.trim()) return;
    storage.getState().updateSessionDraft(chat.anchorSessionId, text);
}
