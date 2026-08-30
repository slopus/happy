/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user is demonstrably looking at a UI client
 * (`user-scoped` socket reporting `app-state: active`), suppress the push —
 * they can see in-app indicators (unread dots, tab title counter) instead.
 * Anything short of that proof sends, because a missed push is far more
 * costly than a redundant one. See eventRouter.hasActiveUiClient (fixes the
 * 2026-08-03 incident where the session's own socket suppressed 100% of pushes
 * and silent sockets suppressed the rest).
 *
 * Every path reports a PushOutcome so callers can tell "delivered" from
 * "suppressed" from "nobody has a device registered" — previously all three
 * looked identical to the CLI, which is how a total push outage stayed
 * invisible for two months.
 *
 * Observability: each outcome also increments push_notifications_total
 * {outcome,kind} (see metrics2.pushNotificationsCounter), so a regression like
 * the 100%-suppression incident is visible at :9090/metrics at a glance (F4).
 */

import { db } from "@/storage/db";
import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { pushNotificationsCounter } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";

/** Normalise the event kind for the metrics label (bounded cardinality). */
function pushKindLabel(data: Record<string, unknown> | undefined): string {
    const kind = data?.kind;
    return kind === 'done' || kind === 'permission' || kind === 'question' ? kind : 'unknown';
}

/** What actually happened to a session-event push. */
export type PushOutcome =
    | { result: 'sent'; tokens: number }
    | { result: 'partial'; tokens: number; delivered: number; reason: string }
    | { result: 'suppressed'; reason: string }
    | { result: 'no_tokens' }
    | { result: 'failed'; reason: string };

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
    kind: string;
}): Promise<PushOutcome> {
    // All push tokens are mobile — web/CLI never register Expo tokens.
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
        pushNotificationsCounter.inc({ outcome: 'no_tokens', kind: params.kind });
        log({ module: 'push' }, `No push tokens for user ${params.userId} session ${params.sessionId} — skipped`);
        return { result: 'no_tokens' };
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
        pushNotificationsCounter.inc({ outcome: 'sent', kind: params.kind });
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
        return { result: 'sent', tokens: okCount };
    }

    // Nothing got through — an Expo outage or timeout, not a per-device problem.
    if (okCount === 0) {
        // F4 observability: a total-delivery failure is an 'error' outcome.
        pushNotificationsCounter.inc({ outcome: 'error', kind: params.kind });
        log({ module: 'push', level: 'error' }, `Push failed for user ${params.userId} session ${params.sessionId}: errors=${JSON.stringify(errors)}`);
        return { result: 'failed', reason: errors.join(', ') };
    }

    // F4 observability: partial delivery still had per-device errors — count as 'error'.
    pushNotificationsCounter.inc({ outcome: 'error', kind: params.kind });
    log({ module: 'push', level: 'warn' }, `Push partial for user ${params.userId} session ${params.sessionId}: ok=${okCount} errors=${JSON.stringify(errors)}`);
    return { result: 'partial', tokens: tokens.length, delivered: okCount, reason: errors.join(', ') };
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<PushOutcome> {
    const { userId, sessionId, title, body, data } = params;
    const kind = pushKindLabel(data);

    try {
        try {
            if (await isUserActive(userId)) {
                pushNotificationsCounter.inc({ outcome: 'suppressed', kind });
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return { result: 'suppressed', reason: 'active-ui-client' };
            }
        } catch (presenceError) {
            // Fail open: if we cannot prove the user is watching, notify them.
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        return await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages',
            kind
        });
    } catch (error) {
        pushNotificationsCounter.inc({ outcome: 'error', kind });
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
        return { result: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}
