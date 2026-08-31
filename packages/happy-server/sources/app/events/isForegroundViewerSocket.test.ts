import { describe, it, expect } from 'vitest';
import { isForegroundViewerSocket } from './eventRouter';

const NOW = 1_000_000_000;

describe('isForegroundViewerSocket (push presence suppression)', () => {
    // F1 — non-viewer sockets never count as a present viewer.
    it('does NOT suppress for the CLI session socket (session-scoped) — the incident cause', () => {
        // A session-scoped socket with no app-state used to be assumed active and
        // suppressed the very push it raised.
        expect(isForegroundViewerSocket({ clientType: 'session-scoped', connectedAt: NOW }, NOW)).toBe(false);
    });

    it('does NOT suppress for the daemon socket (machine-scoped)', () => {
        expect(isForegroundViewerSocket({ clientType: 'machine-scoped', connectedAt: NOW }, NOW)).toBe(false);
    });

    // F2 — viewer sockets only suppress when genuinely foreground.
    it('suppresses when a user-scoped viewer is explicitly active', () => {
        expect(isForegroundViewerSocket({ clientType: 'user-scoped', appState: 'active', appStateAt: NOW }, NOW)).toBe(true);
    });

    it('does NOT suppress when the viewer explicitly reports background', () => {
        expect(isForegroundViewerSocket({ clientType: 'user-scoped', appState: 'background', appStateAt: NOW }, NOW)).toBe(false);
    });

    it('does NOT suppress for a silent/zombie viewer past the grace window — the iOS cause', () => {
        // An iOS socket that never reports app-state (old build / frozen) must not
        // suppress forever. 60s after connect, with no state, it is not foreground.
        expect(isForegroundViewerSocket({ clientType: 'user-scoped', connectedAt: NOW - 60_000 }, NOW)).toBe(false);
    });

    it('gives a freshly-connected viewer the benefit of the doubt within the grace window', () => {
        // Covers the connect -> first app-state event race.
        expect(isForegroundViewerSocket({ clientType: 'user-scoped', connectedAt: NOW - 5_000 }, NOW)).toBe(true);
    });

    it('treats an undefined clientType as a user-scoped viewer (matches connection classification)', () => {
        expect(isForegroundViewerSocket({ appState: 'active', appStateAt: NOW }, NOW)).toBe(true);
        expect(isForegroundViewerSocket({ appState: 'background', appStateAt: NOW }, NOW)).toBe(false);
    });

    it('an explicit active never expires (user watching for minutes still suppresses)', () => {
        expect(isForegroundViewerSocket({ clientType: 'user-scoped', appState: 'active', appStateAt: NOW - 600_000 }, NOW)).toBe(true);
    });

    it('no timing info and no state → does not suppress', () => {
        expect(isForegroundViewerSocket({ clientType: 'user-scoped' }, NOW)).toBe(false);
    });
});
