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
 * Suppression: if the user has a *viewer* client (mobile/web/desktop app) in the
 * foreground, suppress the push — they can see in-app indicators (unread dots,
 * tab title counter) instead. Only a user-scoped socket reporting `app-state:
 * active` counts; the CLI session (session-scoped) and daemon (machine-scoped)
 * do not, and a socket that never reports state is not assumed active beyond a
 * short connect grace. See eventRouter.hasActiveViewerSocket() for the rationale
 * (fixes a 2026-08-03 incident where the session's own socket suppressed 100% of
 * pushes and silent iOS sockets suppressed the rest).
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

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
    kind: string;
}): Promise<void> {
    // All push tokens are mobile — web/CLI never register Expo tokens.
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
        pushNotificationsCounter.inc({ outcome: 'no_tokens', kind: params.kind });
        log({ module: 'push' }, `No push tokens for user ${params.userId} session ${params.sessionId} — skipped`);
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
        pushNotificationsCounter.inc({ outcome: 'sent', kind: params.kind });
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
    } else {
        pushNotificationsCounter.inc({ outcome: 'error', kind: params.kind });
        log({ module: 'push', level: 'warn' }, `Push partial for user ${params.userId} session ${params.sessionId}: ok=${okCount} errors=${JSON.stringify(errors)}`);
    }
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body, data } = params;
    const kind = pushKindLabel(data);

    try {
        try {
            if (await isUserActive(userId)) {
                pushNotificationsCounter.inc({ outcome: 'suppressed', kind });
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        await fetchTokensAndSend({
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
    }
}
