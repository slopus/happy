/**
 * useCloudSession React Hook
 *
 * Provides a simple API for cloud chat sessions in React components.
 * Wraps the CloudSessionManager functions with React state management.
 */

import * as React from 'react';
import { useCloudStreaming } from '@/sync/storage';
import {
    sendCloudMessage,
    abortCloudSession,
    isCloudSessionStreaming,
} from './cloudSession';

export interface UseCloudSessionResult {
    /** Send a text message in this cloud session */
    sendMessage: (text: string) => Promise<void>;

    /** Whether the AI is currently streaming a response */
    isStreaming: boolean;

    /** The current streaming text (partial response) */
    streamingText: string;

    /** Abort the current streaming request */
    abort: () => void;
}

/**
 * Hook for interacting with a cloud chat session.
 *
 * @param sessionId - The cloud session ID
 * @returns Methods and state for the cloud chat
 */
export function useCloudSession(sessionId: string): UseCloudSessionResult {
    const { text: streamingText, isStreaming } = useCloudStreaming(sessionId);

    const sendMessage = React.useCallback(async (text: string) => {
        await sendCloudMessage(sessionId, text);
    }, [sessionId]);

    const abort = React.useCallback(() => {
        abortCloudSession(sessionId);
    }, [sessionId]);

    return {
        sendMessage,
        isStreaming,
        streamingText,
        abort,
    };
}
