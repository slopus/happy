/**
 * Smart push notification dispatch for new messages.
 *
 * Routing rules (evaluated in order, first match wins):
 * 1. User has an active desktop or web socket → suppress all pushes (user is at keyboard)
 * 2. All mobile sockets are in foreground → suppress (app is visible)
 * 3. Otherwise → send push to all registered mobile push tokens
 *
 * Rate limited to one push per user per 10 seconds (in-process debounce).
 * Automatically cleans up invalid tokens (DeviceNotRegistered).
 */

import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { isForeground } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { log } from "@/utils/log";

const RATE_LIMIT_MS = 10_000;
const lastPushAt = new Map<string, number>();

export async function dispatchNewMessagePush(params: {
    userId: string;
    sessionId: string;
}): Promise<void> {
    const { userId, sessionId } = params;

    try {
        // Rate limit: skip if same user got a push within last 10s
        const lastPush = lastPushAt.get(userId);
        if (lastPush && Date.now() - lastPush < RATE_LIMIT_MS) {
            return;
        }

        // Rule 1: user is active on desktop/web → suppress
        const hasDesktop = await eventRouter.hasActiveNonMobileConnection(userId);
        if (hasDesktop) {
            return;
        }

        // Rule 2: all mobile sockets are in foreground → suppress
        const mobileSocketIds = await eventRouter.getMobileSocketIds(userId);
        if (mobileSocketIds.length > 0 && mobileSocketIds.every(id => isForeground(id))) {
            return;
        }

        // Fetch push tokens for mobile platforms
        const tokens = await db.accountPushToken.findMany({
            where: {
                accountId: userId,
                platform: { in: ['ios', 'android'] }
            }
        });

        if (tokens.length === 0) {
            return;
        }

        // Update rate limit
        lastPushAt.set(userId, Date.now());

        // Send push notifications
        const tickets = await sendPushNotifications(
            tokens.map(t => ({
                to: t.token,
                title: 'New message',
                body: 'You have a new message',
                data: { sessionId },
                sound: 'default' as const,
                channelId: 'messages'
            }))
        );

        // Clean up invalid tokens
        for (let i = 0; i < tickets.length; i++) {
            const ticket = tickets[i];
            if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
                void db.accountPushToken.deleteMany({
                    where: { id: tokens[i].id }
                });
            }
        }
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Push dispatch failed: ${error}`);
    }
}
