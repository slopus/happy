/**
 * Sends push notifications via Expo's HTTP Push API.
 * Direct HTTP POST — no expo-server-sdk dependency needed.
 * Batches up to 100 tokens per request (Expo's documented limit).
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

export interface PushMessage {
    to: string;
    title?: string;
    body?: string;
    data?: Record<string, string>;
    sound?: 'default' | null;
    badge?: number;
    channelId?: string;
}

export interface PushTicket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
}

export async function sendPushNotifications(messages: PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) {
        return [];
    }

    const tickets: PushTicket[] = [];

    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch)
            });

            if (!response.ok) {
                tickets.push(...batch.map(() => ({
                    status: 'error' as const,
                    message: `HTTP ${response.status}`
                })));
                continue;
            }

            const result = await response.json() as { data: PushTicket[] };
            tickets.push(...result.data);
        } catch {
            tickets.push(...batch.map(() => ({
                status: 'error' as const,
                message: 'Network error'
            })));
        }
    }

    return tickets;
}
