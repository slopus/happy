/**
 * Checks whether a user has a *viewer* client actively in the foreground —
 * a human looking at Happy right now, for whom an "attention needed" push
 * would be redundant.
 *
 * Only user-scoped sockets (mobile / web / desktop app) that have explicitly
 * reported `app-state: active` count. The CLI session (session-scoped) and the
 * daemon (machine-scoped) never mean a human is watching, and a socket that has
 * never reported its state is not assumed active beyond a short connect grace.
 * See eventRouter.hasActiveViewerSocket() for the full rationale.
 *
 * State lives on `socket.data` — set by the `app-state` socket event in
 * socket.ts. No external storage (Redis, Maps) needed: when a socket disconnects
 * the state disappears automatically.
 */

import { eventRouter } from "@/app/events/eventRouter";

export async function isUserActive(userId: string): Promise<boolean> {
    return eventRouter.hasActiveViewerSocket(userId);
}
