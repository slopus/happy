import { describe, it, expect } from 'vitest';
import type { Server } from 'socket.io';
import { eventRouter } from './eventRouter';

// hasActiveUiClient only touches `io.in(room).timeout(ms).fetchSockets()`, so a
// tiny stub is enough — it ignores the room and returns the provided sockets.
function stubIo(sockets: Array<{ data: Record<string, unknown> }>): Server {
    const room = { timeout: () => room, fetchSockets: async () => sockets };
    return { in: () => room } as unknown as Server;
}

function socket(clientType: string | undefined, appState?: string): { data: Record<string, unknown> } {
    const data: Record<string, unknown> = {};
    if (clientType !== undefined) data.clientType = clientType;
    if (appState !== undefined) data.appState = appState;
    return { data };
}

describe('EventRouter.hasActiveUiClient', () => {
    it('counts a foreground UI client as present', async () => {
        eventRouter.init(stubIo([socket('user-scoped', 'active')]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(true);
    });

    it('does not count a backgrounded UI client', async () => {
        eventRouter.init(stubIo([socket('user-scoped', 'background')]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });

    it('ignores coding-session sockets, which never report app-state', async () => {
        // A running coding session is connected for the whole session and is the
        // agent, not the user. Counting it meant a session suppressed its own push.
        eventRouter.init(stubIo([socket('session-scoped'), socket('session-scoped')]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });

    it('ignores the daemon socket', async () => {
        eventRouter.init(stubIo([socket('machine-scoped')]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });

    it('treats a UI client that never reported app-state as unknown, not present', async () => {
        // Presence must be proven. Assuming it here is what silenced old clients.
        eventRouter.init(stubIo([socket('user-scoped')]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });

    it('treats a socket without a clientType as unknown, not present', async () => {
        eventRouter.init(stubIo([socket(undefined, 'active')]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });

    it('sends when the phone is backgrounded while coding sessions are live', async () => {
        // The exact regression: phone backgrounded, sessions still connected.
        // This is precisely when the user wants the push.
        eventRouter.init(stubIo([
            socket('session-scoped'),
            socket('session-scoped'),
            socket('machine-scoped'),
            socket('user-scoped', 'background'),
        ]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });

    it('suppresses when any UI client is foreground, even alongside sessions', async () => {
        eventRouter.init(stubIo([
            socket('session-scoped'),
            socket('user-scoped', 'background'),
            socket('user-scoped', 'active'),
        ]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(true);
    });

    it('sends when nothing is connected', async () => {
        eventRouter.init(stubIo([]));
        expect(await eventRouter.hasActiveUiClient('u1')).toBe(false);
    });
});
