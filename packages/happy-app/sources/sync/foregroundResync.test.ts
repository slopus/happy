import { describe, expect, it, vi } from 'vitest';
import { resyncOnForeground, type Invalidatable } from './foregroundResync';

const makeSync = (): Invalidatable => ({ invalidate: vi.fn() });

describe('resyncOnForeground', () => {
    it('invalidates every global sync on resume', () => {
        const globalSyncs = [makeSync(), makeSync(), makeSync()];

        resyncOnForeground({
            globalSyncs,
            currentViewingSessionId: null,
            onSessionVisible: vi.fn(),
        });

        for (const sync of globalSyncs) {
            expect(sync.invalidate).toHaveBeenCalledTimes(1);
        }
    });

    // Regression for slopus/happy#1308: a backgrounded socket misses realtime
    // message deliveries, and before this the open chat was never re-fetched on
    // foreground — it stayed stale until the user left and re-entered the chat.
    it('re-fetches the visible session messages on resume when a chat is open', () => {
        const onSessionVisible = vi.fn();

        resyncOnForeground({
            globalSyncs: [],
            currentViewingSessionId: 'session-123',
            onSessionVisible,
        });

        expect(onSessionVisible).toHaveBeenCalledTimes(1);
        expect(onSessionVisible).toHaveBeenCalledWith('session-123');
    });

    it('does not re-fetch a session when no chat is open', () => {
        const onSessionVisible = vi.fn();

        resyncOnForeground({
            globalSyncs: [makeSync()],
            currentViewingSessionId: null,
            onSessionVisible,
        });

        expect(onSessionVisible).not.toHaveBeenCalled();
    });
});
