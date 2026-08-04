/**
 * Checks whether the user is actively looking at a Happy UI client
 * (mobile app / web / desktop).
 *
 * "Active" requires positive proof: a `user-scoped` socket that reported
 * `app-state: active`. Coding sessions (`session-scoped`) and the daemon
 * (`machine-scoped`) are not notification surfaces, and a client that never
 * reported its state is unknown rather than present — so we send.
 *
 * Note that a session driven from the user's own terminal never reaches this
 * check at all: the CLI only emits session pushes from its remote launcher
 * (see packages/happy-cli/src/claude/loop.ts), so "user is at the keyboard"
 * is handled structurally rather than guessed at here.
 *
 * State lives on `socket.data.appState` — set by the `app-state` socket
 * event in socket.ts. No external storage (Redis, Maps) needed: when a
 * socket disconnects the state disappears automatically.
 */

import { eventRouter } from "@/app/events/eventRouter";

export async function isUserActive(userId: string): Promise<boolean> {
    return eventRouter.hasActiveUiClient(userId);
}
