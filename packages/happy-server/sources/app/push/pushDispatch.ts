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
 * Suppression: DISABLED. Session-event pushes (done/permission/question)
 * always fire, even when an app client is connected/foreground — the user
 * wants a system notification whenever Claude finishes or needs interaction,
 * regardless of whether the app is open. (The foreground display itself is
 * additionally gated client-side in app/_layout.tsx's notification handler.)
 */

import { db } from "@/storage/db";
import { sendPushNotifications } from "@/app/push/pushSend";
import { log } from "@/utils/log";

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId?: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<void> {
    // All push tokens are mobile — web/CLI never register Expo tokens.
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
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
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
    } else {
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

    try {
        // No presence-based suppression: always deliver session-event pushes
        // so the user gets a notification even with the app open/foreground.
        await fetchTokensAndSend({
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

/** Generic scheduling failures contain no private task title, instruction or filesystem path. */
export async function dispatchScheduledTaskPush(params: { userId: string; taskId: string; runId: string; sessionId: string | null }): Promise<void> {
    await fetchTokensAndSend({ userId: params.userId, sessionId: params.sessionId ?? undefined,
        title: 'Scheduled task needs attention', body: 'Open Scheduled tasks to review the execution.', channelId: 'messages',
        data: { url: '/scheduled-tasks', taskId: params.taskId, runId: params.runId, kind: 'permission', ...(params.sessionId ? { sessionId: params.sessionId } : {}) } });
}
