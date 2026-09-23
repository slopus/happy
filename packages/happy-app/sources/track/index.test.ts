import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-updates', () => ({ updateId: null, runtimeVersion: null }));
vi.mock('./tracking', () => ({ tracking: { capture: mocks.capture } }));

import { trackSessionSwitched } from './index';

describe('session_switched', () => {
    beforeEach(() => {
        mocks.capture.mockClear();
    });

    it('carries no properties at all', () => {
        trackSessionSwitched();

        expect(mocks.capture).toHaveBeenCalledExactlyOnceWith('session_switched');
    });

    it('sends nothing the relay could join back to its own rows', () => {
        trackSessionSwitched();

        // PRIVACY.md states analytics cannot be matched back to a user or
        // account. The distinct id is unlinkable on its own, so that claim
        // holds only while the properties stay free of server-owned keys: the
        // Session primary key and the server's own createdAt / activeAt /
        // updatedAt used to be sent here and joined straight back to it.
        const [, properties] = mocks.capture.mock.calls[0];
        expect(properties).toBeUndefined();
    });
});
