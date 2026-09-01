import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the create/unmount surface below.
import TestRenderer from 'react-test-renderer';

vi.mock('@/hooks/useUpdates', () => ({ useUpdates: () => ({ updateAvailable: false }) }));
vi.mock('@/sync/storage', () => ({
    useFeedItems: () => [],
    useFriendRequests: () => [],
    useRequestedFriends: () => [],
}));
vi.mock('@/hooks/useChangelog', () => ({ useChangelog: () => ({ hasUnread: true }) }));
vi.mock('@/hooks/useCodexAttachCandidateInbox', () => ({
    useCodexAttachCandidateInbox: () => ({ candidates: [] }),
}));

import { useInboxHasContent } from './useInboxHasContent';

describe('useInboxHasContent', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it('does not treat an unread changelog entry as inbox content', () => {
        let hasContent: boolean | undefined;

        function Harness() {
            hasContent = useInboxHasContent();
            return null;
        }

        act(() => {
            renderer = TestRenderer.create(<Harness />);
        });

        expect(hasContent).toBe(false);
    });
});
