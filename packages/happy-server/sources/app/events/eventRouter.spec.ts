import { describe, it, expect } from 'vitest';
import type { Server } from 'socket.io';
import { eventRouter } from './eventRouter';

// hasActiveNonMachineSocket only touches `io.in(room).fetchSockets()`, so a tiny
// stub is enough — it ignores the room and returns the provided sockets.
function stubIo(sockets: Array<{ data: Record<string, unknown> }>): Server {
    return { in: () => ({ fetchSockets: async () => sockets }) } as unknown as Server;
}

function socket(clientType: string, appState?: string): { data: Record<string, unknown> } {
    return { data: appState === undefined ? { clientType } : { clientType, appState } };
}

describe('EventRouter.hasActiveNonMachineSocket', () => {
    it('ignores session-scoped (CLI agent) sockets, even without app-state', async () => {
        // A running coding session is always connected as session-scoped and never
        // sends app-state. It is the agent, not the user viewing Happy, so it must
        // not count as presence — otherwise a session suppresses its own push.
        eventRouter.init(stubIo([socket('session-scoped'), socket('session-scoped')]));
        expect(await eventRouter.hasActiveNonMachineSocket('u1')).toBe(false);
    });

    it('ignores the machine-scoped daemon socket', async () => {
        eventRouter.init(stubIo([socket('machine-scoped')]));
        expect(await eventRouter.hasActiveNonMachineSocket('u1')).toBe(false);
    });

    it('is active when a user-scoped client is foreground or has not reported app-state', async () => {
        eventRouter.init(stubIo([socket('user-scoped', 'active')]));
        expect(await eventRouter.hasActiveNonMachineSocket('u1')).toBe(true);

        eventRouter.init(stubIo([socket('user-scoped')]));
        expect(await eventRouter.hasActiveNonMachineSocket('u1')).toBe(true);
    });

    it('is not active when the only user-scoped client is backgrounded, despite session sockets', async () => {
        // The exact regression: phone backgrounded but CLI sessions still connected.
        eventRouter.init(stubIo([
            socket('session-scoped'),
            socket('session-scoped'),
            socket('user-scoped', 'background'),
        ]));
        expect(await eventRouter.hasActiveNonMachineSocket('u1')).toBe(false);
    });
});
