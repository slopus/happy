/**
 * Checks whether a user is actively looking at any Happy client.
 *
 * "Active" means a non-machine socket is connected AND has not reported
 * `app-state: background`. Old clients that never send `app-state` are
 * treated as active (connected = present) for backwards compatibility.
 *
 * State lives on `socket.data.appState` — set by the `app-state` socket
 * event in socket.ts. No external storage (Redis, Maps) needed: when a
 * socket disconnects the state disappears automatically.
 */

import { eventRouter } from "@/app/events/eventRouter";

export async function isUserActive(userId: string): Promise<boolean> {
    return eventRouter.hasActiveNonMachineSocket(userId);
}
