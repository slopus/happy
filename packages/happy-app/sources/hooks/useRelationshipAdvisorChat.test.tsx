import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRelationshipAdvisorChat } from './useRelationshipAdvisorChat';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    conversations: [{
        id: 'conversation-1',
        title: 'New conversation',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
    }],
    updateConversations: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    uploadImages: vi.fn(),
    discardImages: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'request-1' }));
vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => mocks.conversations,
    useLocalSettingUpdater: () => mocks.updateConversations,
}));
vi.mock('@/sync/relationshipAdvisorClient', () => ({
    relationshipAdvisorClient: {
        start: mocks.start,
        cancel: mocks.cancel,
    },
}));
vi.mock('@/sync/relationshipAdvisorImages', () => ({
    uploadRelationshipAdvisorImages: mocks.uploadImages,
    discardRelationshipAdvisorImages: mocks.discardImages,
}));

type HookResult = ReturnType<typeof useRelationshipAdvisorChat>;

function renderHook(): { current: () => HookResult; unmount: () => void } {
    let result: HookResult | undefined;
    let renderer: { unmount: () => void } | undefined;
    function Harness() {
        result = useRelationshipAdvisorChat('conversation-1');
        return null;
    }
    act(() => {
        renderer = TestRenderer.create(<Harness />);
    });
    return {
        current: () => {
            if (!result) throw new Error('Hook did not render');
            return result;
        },
        unmount: () => act(() => renderer?.unmount()),
    };
}

describe('useRelationshipAdvisorChat', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.uploadImages.mockResolvedValue([]);
        mocks.discardImages.mockResolvedValue(undefined);
        mocks.updateConversations.mockImplementation((updater: (value: typeof mocks.conversations) => typeof mocks.conversations) => {
            mocks.conversations = updater(mocks.conversations);
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('unsubscribes when the provider acknowledgement resolves after unmount', async () => {
        let resolveStart: (unsubscribe: () => void) => void = () => undefined;
        const unsubscribe = vi.fn();
        mocks.start.mockReturnValue(new Promise<() => void>((resolve) => {
            resolveStart = resolve;
        }));
        const hook = renderHook();

        let sendPromise: Promise<boolean>;
        act(() => {
            sendPromise = hook.current().send('hello', []);
        });
        await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
        hook.unmount();
        await act(async () => {
            resolveStart(unsubscribe);
            await sendPromise!;
        });

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(mocks.cancel).toHaveBeenCalledWith('request-1');
    });

    it('settles a provider rejection after unmount without retaining the request', async () => {
        let rejectStart: (error: Error) => void = () => undefined;
        mocks.start.mockReturnValue(new Promise<() => void>((_resolve, reject) => {
            rejectStart = reject;
        }));
        const hook = renderHook();

        let sendPromise: Promise<boolean>;
        act(() => {
            sendPromise = hook.current().send('hello', []);
        });
        await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
        hook.unmount();
        await act(async () => {
            rejectStart(new Error('late rejection'));
            await expect(sendPromise!).resolves.toBe(false);
        });

        expect(mocks.cancel).toHaveBeenCalledWith('request-1');
    });
});
