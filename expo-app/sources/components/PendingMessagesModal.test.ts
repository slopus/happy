import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchPendingMessages = vi.fn();
const sendMessage = vi.fn();
const deletePendingMessage = vi.fn();
const deleteDiscardedPendingMessage = vi.fn();
const sessionAbort = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/storage', () => ({
    useSessionPendingMessages: () => ({
        isLoaded: true,
        messages: [
            { id: 'p1', text: 'hello', displayText: null, createdAt: 0, updatedAt: 0 },
        ],
        discarded: [],
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchPendingMessages: (...args: any[]) => fetchPendingMessages(...args),
        sendMessage: (...args: any[]) => sendMessage(...args),
        deletePendingMessage: (...args: any[]) => deletePendingMessage(...args),
        updatePendingMessage: vi.fn(),
        restoreDiscardedPendingMessage: vi.fn(),
        deleteDiscardedPendingMessage: (...args: any[]) => deleteDiscardedPendingMessage(...args),
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAbort: (...args: any[]) => sessionAbort(...args),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: any[]) => modalConfirm(...args),
        alert: (...args: any[]) => modalAlert(...args),
        prompt: vi.fn(),
    },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                surfaceHighest: '#eee',
                input: { background: '#fff' },
                button: {
                    secondary: { background: '#eee', tint: '#000' },
                },
                box: {
                    danger: { background: '#fdd', text: '#a00' },
                },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('PendingMessagesModal', () => {
    beforeEach(() => {
        fetchPendingMessages.mockReset();
        sendMessage.mockReset();
        deletePendingMessage.mockReset();
        deleteDiscardedPendingMessage.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
    });

    it('does not close the modal until abort+send+delete succeed', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        const onClose = vi.fn();
        const { PendingMessagesModal } = await import('./PendingMessagesModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesModal, { sessionId: 's1', onClose }));
        });

        const sendNow = tree!.root
            .findAllByType('Pressable' as any)
            .find((p) => p.props.testID === 'pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await act(async () => {
            await sendNow!.props.onPress();
        });

        expect(sessionAbort).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);

        const abortOrder = sessionAbort.mock.invocationCallOrder[0]!;
        const sendOrder = sendMessage.mock.invocationCallOrder[0]!;
        const deleteOrder = deletePendingMessage.mock.invocationCallOrder[0]!;
        const closeOrder = onClose.mock.invocationCallOrder[0]!;

        expect(abortOrder).toBeLessThan(sendOrder);
        expect(sendOrder).toBeLessThan(deleteOrder);
        expect(deleteOrder).toBeLessThan(closeOrder);
    });

    it('does not delete or close when send fails', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockRejectedValueOnce(new Error('send failed'));

        const onClose = vi.fn();
        const { PendingMessagesModal } = await import('./PendingMessagesModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesModal, { sessionId: 's1', onClose }));
        });

        const sendNow = tree!.root
            .findAllByType('Pressable' as any)
            .find((p) => p.props.testID === 'pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await act(async () => {
            await sendNow!.props.onPress();
        });

        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(onClose).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(1);
    });
});
