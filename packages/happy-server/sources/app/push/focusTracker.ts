/**
 * Checks whether a user is actively looking at any Happy UI client
 * (mobile app / web).
 *
 * "Active" means a `user-scoped` socket is connected AND has not reported
 * `app-state: background`. The daemon (machine-scoped) and CLI coding
 * sessions (session-scoped) do NOT count — they are background processes
 * that never display notifications, so they must not suppress push.
 *
 * State lives on `socket.data.appState` — set by the `app-state` socket
 * event in socket.ts. No external storage (Redis, Maps) needed: when a
 * socket disconnects the state disappears automatically.
 */

import { eventRouter } from "@/app/events/eventRouter";

export async function isUserActive(userId: string): Promise<boolean> {
    return eventRouter.hasActiveUiClient(userId);
}
