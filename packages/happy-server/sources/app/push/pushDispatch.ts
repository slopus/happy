/**
 * Smart push notification dispatch.
 *
 * Two entry points:
 *   - dispatchNewMessagePush: generic "you have a new message" on session-message create
 *   - dispatchSessionEventPush: rich session-event (e.g. "It's ready!", permission, question)
 *     called from clients (CLI/daemon) that previously bypassed routing by talking to Expo directly.
 *
 * Suppression rules for new-message push (first match wins):
 *   0. Sender is web/desktop → suppress (user just typed it on the PC, no need to ping phone)
 *   0.5. Sender is CLI but the user kicked the turn off from web/desktop within 5 min →
 *       suppress (user is at the PC, possibly glancing at another tab while waiting)
 *   1. Any web/desktop socket is in foreground (visible AND focused) → suppress (user is at keyboard)
 *   2. All mobile sockets are in foreground → suppress (app is visible)
 *   3. Otherwise → send push to all registered mobile push tokens
 *
 * dispatchSessionEventPush applies rule 0.5 + 1 + 2: even attention-grabbing
 * events ("It's ready!", permission, question) shouldn't ping the phone if the
 * user is the one driving the conversation from a PC. After 5 min of PC silence
 * the TTL drops and the event reaches the phone normally.
 *
 * "Foreground" is reported by clients via the `app-state` socket event.
 * A connected-but-backgrounded web tab does NOT count as keyboard presence,
 * so leaving a tab open in another window won't silently swallow phone pushes.
 *
 * Rate limit (10s/user) only applies to dispatchNewMessagePush — session events
 * are sparse and carry meaningful state changes that shouldn't be debounced.
 */

import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { isForeground } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { log } from "@/utils/log";

const RATE_LIMIT_MS = 10_000;
const lastPushAt = new Map<string, number>();

// Tracks where the user last typed in a given session, so Claude's response —
// which always arrives via CLI/daemon — can inherit the originator's intent.
// "I just typed this from my PC, I'm coming back to it" → don't ping the phone,
// even if I briefly switched browser tab while waiting.
type TurnOriginEntry = { origin: 'web-desktop' | 'mobile'; at: number };
const turnOriginByUserSession = new Map<string, TurnOriginEntry>();
const TURN_ORIGIN_TTL_MS = 5 * 60 * 1000;

function turnOriginKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
}

function classifyOrigin(happyClient: string | null | undefined): 'web-desktop' | 'mobile' | 'cli' | null {
    if (!happyClient) return null;
    if (happyClient.startsWith('web/') || happyClient.startsWith('desktop/')) return 'web-desktop';
    if (happyClient.startsWith('ios/') || happyClient.startsWith('android/')) return 'mobile';
    if (happyClient.startsWith('cli')) return 'cli';
    return null;
}

function recordTurnOrigin(userId: string, sessionId: string, happyClient: string | null | undefined) {
    const origin = classifyOrigin(happyClient);
    if (origin !== 'web-desktop' && origin !== 'mobile') {
        return;
    }
    turnOriginByUserSession.set(turnOriginKey(userId, sessionId), { origin, at: Date.now() });
}

function getRecentTurnOrigin(userId: string, sessionId: string): TurnOriginEntry['origin'] | null {
    const key = turnOriginKey(userId, sessionId);
    const entry = turnOriginByUserSession.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > TURN_ORIGIN_TTL_MS) {
        turnOriginByUserSession.delete(key);
        return null;
    }
    return entry.origin;
}

type SuppressDecision =
    | { suppress: true; reason: 'desktop-foreground' | 'mobile-foreground' }
    | { suppress: false; reason: 'no-mobile-connected' | 'no-foreground-client' };

/**
 * Decides whether presence rules say to skip the push.
 * "Foreground" means the user is actively at that client (visible & focused).
 * A connected-but-backgrounded web tab no longer counts as keyboard presence —
 * otherwise pushes never reach the phone when a forgotten tab stays open.
 *
 * Fail-open: throws bubble up to caller, which logs and proceeds to send.
 */
async function evaluateSuppression(userId: string): Promise<SuppressDecision> {
    const desktopSocketIds = await eventRouter.getNonMobileSocketIds(userId);
    if (desktopSocketIds.length > 0) {
        const desktopForeground = await Promise.all(desktopSocketIds.map(id => isForeground(id)));
        if (desktopForeground.some(Boolean)) {
            return { suppress: true, reason: 'desktop-foreground' };
        }
    }

    const mobileSocketIds = await eventRouter.getMobileSocketIds(userId);
    if (mobileSocketIds.length === 0) {
        return { suppress: false, reason: 'no-mobile-connected' };
    }
    const mobileForeground = await Promise.all(mobileSocketIds.map(id => isForeground(id)));
    if (mobileForeground.every(Boolean)) {
        return { suppress: true, reason: 'mobile-foreground' };
    }
    return { suppress: false, reason: 'no-foreground-client' };
}

async function fetchMobileTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<void> {
    const tokens = await db.accountPushToken.findMany({
        where: {
            accountId: params.userId,
            platform: { in: ['ios', 'android'] }
        }
    });

    if (tokens.length === 0) {
        log({ module: 'push' }, `No mobile tokens for user ${params.userId} session ${params.sessionId} — push skipped`);
        return;
    }

    const tickets = await sendPushNotifications(
        tokens.map(t => ({
            to: t.token,
            title: params.title,
            body: params.body,
            data: params.data,
            sound: 'default' as const,
            channelId: params.channelId
        }))
    );

    let okCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        errors.push(ticket.details?.error || ticket.message || 'unknown');
        if (ticket.details?.error === 'DeviceNotRegistered') {
            void db.accountPushToken.deleteMany({
                where: { id: tokens[i].id }
            });
        }
    }

    if (errors.length === 0) {
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
    } else {
        log({ module: 'push', level: 'warn' }, `Push partial for user ${params.userId} session ${params.sessionId}: ok=${okCount} errors=${JSON.stringify(errors)}`);
    }
}

export async function dispatchNewMessagePush(params: {
    userId: string;
    sessionId: string;
    /** X-Happy-Client of the request that created the message (e.g. "web/1.7.0", "ios/1.7.0", "cli-coding-session/1.1.8"). */
    senderHappyClient?: string | null;
}): Promise<void> {
    const { userId, sessionId, senderHappyClient } = params;

    try {
        const senderOrigin = classifyOrigin(senderHappyClient);

        // Remember where the user typed, so when Claude's response arrives via CLI
        // we can inherit that intent (see Rule 0.5).
        recordTurnOrigin(userId, sessionId, senderHappyClient);

        // Rule 0: message originated from a non-mobile user client → user just typed it on
        // the PC themselves, don't ping their phone. CLI/daemon senders fall through —
        // those are Claude's responses, and the user does want to be notified about them.
        if (senderOrigin === 'web-desktop') {
            log({ module: 'push' }, `Suppressed new-message push for user ${userId} session ${sessionId}: sent-from-desktop (${senderHappyClient})`);
            return;
        }

        // Rule 0.5: Claude's response (CLI sender) for a turn the user kicked off from PC.
        // Phone is not where they're working right now — they're at the PC, possibly
        // glancing at another tab while waiting. Don't disturb the phone.
        if (senderOrigin === 'cli' && getRecentTurnOrigin(userId, sessionId) === 'web-desktop') {
            log({ module: 'push' }, `Suppressed new-message push for user ${userId} session ${sessionId}: turn-initiated-from-desktop`);
            return;
        }

        const lastPush = lastPushAt.get(userId);
        if (lastPush && Date.now() - lastPush < RATE_LIMIT_MS) {
            log({ module: 'push' }, `Rate-limited new-message push for user ${userId} session ${sessionId}`);
            return;
        }

        try {
            const decision = await evaluateSuppression(userId);
            if (decision.suppress) {
                log({ module: 'push' }, `Suppressed new-message push for user ${userId} session ${sessionId}: ${decision.reason}`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        lastPushAt.set(userId, Date.now());

        await fetchMobileTokensAndSend({
            userId,
            sessionId,
            title: 'New message',
            body: 'You have a new message',
            data: { sessionId },
            channelId: 'messages'
        });
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Push dispatch failed: ${error}`);
    }
}

/**
 * Dispatch a contextual session-event push (called by CLI/daemon clients).
 * Reuses the same presence-based suppression as dispatchNewMessagePush.
 */
export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body, data } = params;

    try {
        // Rule 0.5: turn was kicked off from PC — user is driving the conversation
        // from the keyboard, don't hijack their phone for "done"/"permission"/"question".
        // After TTL expires we assume they've walked away and let the push through.
        if (getRecentTurnOrigin(userId, sessionId) === 'web-desktop') {
            log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: turn-initiated-from-desktop`);
            return;
        }

        try {
            const decision = await evaluateSuppression(userId);
            if (decision.suppress) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: ${decision.reason}`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        await fetchMobileTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages'
        });
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
    }
}
