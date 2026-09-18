import { failPendingChat, getPendingChat, settlePendingChat } from '@/sync/pendingChats';
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
 *
 * Everything is in place before the settle, and therefore before the screen
 * reacts to it by routing to the real chat: the composer that mounts there
 * hydrates its draft synchronously, so a draft written afterwards would arrive
 * to a field that has already read an empty one — and a message put back after
 * a rejected send would be overwritten by the next autosave of whatever the
 * user typed in the meantime.
 */
export function handOverPendingChat(id: string, sessionId: string): void {
    const chat = getPendingChat(id);
    if (!chat) {
        settlePendingChat(id, sessionId);
        return;
    }

    if (chat.queued.length === 0) {
        // Nothing to deliver: the draft is handed over and the chat is real in
        // the same tick, which is what keeps the keyboard from noticing.
        writeDraft(sessionId, chat.draft);
        settlePendingChat(id, sessionId);
        return;
    }

    void deliverAndSettle(id, sessionId, chat.queued);
}

/**
 * Messages already sent go out from here rather than from the arriving
 * screen, which may not be mounted yet — or ever, if the user has moved on
 * to a sibling tab in the meantime. Awaited one after another so they reach
 * the agent in the order they were written.
 *
 * The stand-in stays on screen until they have been accepted. A send that the
 * chat declines — the session not ready, an attachment policy, a permission
 * mode the agent cannot honour — hands its text back rather than dropping it:
 * the rejected message and everything queued behind it go into the draft, in
 * front of whatever is still being typed, where the real composer picks them
 * up the moment it mounts.
 */
async function deliverAndSettle(id: string, sessionId: string, queued: readonly string[]): Promise<void> {
    const unsent: string[] = [];
    let failed = false;
    for (const message of queued) {
        if (!failed) {
            try {
                if (await sync.sendMessage(sessionId, message.trim(), { source: 'new_session' })) continue;
            } catch (error) {
                Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : 'Failed to send the first message',
                );
            }
            // Order matters more than throughput: a message that failed to send
            // must not be overtaken by the one written after it.
            failed = true;
        }
        unsent.push(message);
    }

    // Read again rather than from the record above: keystrokes kept landing
    // in the stand-in while the messages were going out.
    const draft = getPendingChat(id)?.draft ?? '';
    writeDraft(sessionId, [...unsent, draft].filter((part) => part.trim()).join('\n\n'));
    settlePendingChat(id, sessionId);
}

function writeDraft(sessionId: string, text: string): void {
    if (!text.trim()) return;
    storage.getState().updateSessionDraft(sessionId, text);
}

/**
 * The start is not coming. It has already said why; this hands the writing
 * back and then retires the tab.
 *
 * Done here, where the start reports its failure, rather than by the screen
 * standing on the stand-in: that screen is unmounted the moment the user
 * switches to a sibling tab, and a failure that lands while it is away would
 * otherwise leave the text in a record nothing draws any more — and the next
 * `+` sweeps it.
 */
export function retirePendingChat(id: string): void {
    returnPendingChatDraft(id);
    failPendingChat(id);
}

/**
 * The writing from a chat that is not coming is put back on the chat the
 * stand-in was opened beside, which is where the screen returns to. Messages
 * that were sent count as writing here — nothing ever received them, so they
 * are text the user still has.
 *
 * In front of a draft already sitting on the anchor rather than instead of
 * it: that draft is the user's other unfinished thought, and this one is not
 * worth losing over it either.
 *
 * Once, however many times it is asked: a record that has already given its
 * text back has nothing left to give, and giving it twice would double it.
 */
export function returnPendingChatDraft(id: string): void {
    const chat = getPendingChat(id);
    if (!chat || chat.status === 'failed') return;
    const text = [...chat.queued, chat.draft].filter((part) => part.trim()).join('\n\n');
    if (!text) return;
    const anchor = storage.getState().sessions[chat.anchorSessionId];
    if (!anchor) return;
    const existing = anchor.draft?.trim() ? anchor.draft : '';
    storage.getState().updateSessionDraft(
        chat.anchorSessionId,
        existing ? `${text}\n\n${existing}` : text,
    );
}
