import * as React from 'react';
import { randomUUID } from 'expo-crypto';

import type { AttachmentPreview } from '@/sync/attachmentTypes';
import {
    relationshipAdvisorClient,
    type RelationshipAdvisorEvent,
    type RelationshipAdvisorMessage,
} from '@/sync/relationshipAdvisorClient';
import {
    discardRelationshipAdvisorImages,
    uploadRelationshipAdvisorImages,
} from '@/sync/relationshipAdvisorImages';
import { useLocalSetting, useLocalSettingUpdater } from '@/sync/storage';
import {
    relationshipAdvisorChatReducer,
    type RelationshipAdvisorChatMessage,
} from '@/components/relationship-advisor/relationshipAdvisorChatModel';
import {
    buildRelationshipAdvisorConversationTitle,
    saveRelationshipAdvisorConversation,
} from '@/components/relationship-advisor/relationshipAdvisorHistoryModel';

/** Owns one cloud generation, token stream, image uploads, and its device-local conversation. */
export function useRelationshipAdvisorChat(conversationId: string) {
    const conversations = useLocalSetting('relationshipAdvisorConversations');
    const updateConversations = useLocalSettingUpdater('relationshipAdvisorConversations');
    const conversation = conversations.find(({ id }) => id === conversationId);
    const [state, dispatch] = React.useReducer(relationshipAdvisorChatReducer, {
        messages: conversation?.messages ?? [],
        activeRequestId: null,
        streamingText: '',
        error: null,
    });
    const persistedMessagesRef = React.useRef(conversation?.messages ?? []);
    const unsubscribeRef = React.useRef<(() => void) | null>(null);
    const activeRequestIdRef = React.useRef<string | null>(null);
    const providerStartedRequestIdRef = React.useRef<string | null>(null);
    const cancelledRequestIdsRef = React.useRef(new Set<string>());
    const lastAttemptRef = React.useRef<{ text: string; images: AttachmentPreview[] } | null>(null);
    const [canRetry, setCanRetry] = React.useState(false);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        if (persistedMessagesRef.current === state.messages) return;
        persistedMessagesRef.current = state.messages;
        const messages = state.messages.length > 50 ? state.messages.slice(-50) : state.messages;
        updateConversations((latest) => {
            const latestConversation = latest.find(({ id }) => id === conversationId);
            if (!latestConversation) return latest;
            const lastMessageAt = messages.at(-1)?.createdAt ?? latestConversation.updatedAt;
            return saveRelationshipAdvisorConversation(latest, {
                ...latestConversation,
                title: buildRelationshipAdvisorConversationTitle(messages, latestConversation.title),
                updatedAt: Math.max(latestConversation.updatedAt, lastMessageAt),
                messages,
            });
        });
    }, [conversationId, state.messages, updateConversations]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            unsubscribeRef.current?.();
            const activeRequestId = activeRequestIdRef.current;
            if (activeRequestId) {
                cancelledRequestIdsRef.current.add(activeRequestId);
                if (providerStartedRequestIdRef.current === activeRequestId) {
                    relationshipAdvisorClient.cancel(activeRequestId);
                }
            }
        };
    }, []);

    const send = React.useCallback(async (
        text: string,
        images: AttachmentPreview[],
        options?: { reuseLastUser?: boolean },
    ) => {
        const trimmed = text.trim();
        if (activeRequestIdRef.current || (!trimmed && images.length === 0)) return false;

        const requestId = randomUUID();
        activeRequestIdRef.current = requestId;
        lastAttemptRef.current = { text: trimmed, images };
        setCanRetry(false);
        const userMessage: RelationshipAdvisorChatMessage = {
            id: `user-${requestId}`,
            role: 'user',
            text: trimmed,
            createdAt: Date.now(),
            imageCount: images.length,
        };
        const requestMessages: RelationshipAdvisorMessage[] = options?.reuseLastUser
            ? state.messages.slice(-12).map(({ role, text: messageText }) => ({ role, text: messageText }))
            : [
                ...state.messages.slice(-11).map(({ role, text: messageText }) => ({ role, text: messageText })),
                { role: 'user', text: trimmed },
            ];
        dispatch({
            type: 'start',
            requestId,
            message: userMessage,
            appendMessage: !options?.reuseLastUser,
        });

        const imageRefs: string[] = [];
        try {
            const uploadedRefs = await uploadRelationshipAdvisorImages(images, {
                isCancelled: () => cancelledRequestIdsRef.current.has(requestId),
            });
            if (!uploadedRefs) {
                cancelledRequestIdsRef.current.delete(requestId);
                return false;
            }
            imageRefs.push(...uploadedRefs);

            let terminalEventReceived = false;
            const onEvent = (event: RelationshipAdvisorEvent) => {
                if (!mountedRef.current) return;
                dispatch({ type: 'event', event, completedAt: Date.now() });
                if (event.type === 'done' || event.type === 'error') {
                    activeRequestIdRef.current = null;
                    providerStartedRequestIdRef.current = null;
                    cancelledRequestIdsRef.current.delete(requestId);
                    if (event.type === 'error') {
                        setCanRetry(true);
                    } else {
                        lastAttemptRef.current = null;
                        setCanRetry(false);
                    }
                    terminalEventReceived = true;
                    unsubscribeRef.current?.();
                    unsubscribeRef.current = null;
                }
            };
            providerStartedRequestIdRef.current = requestId;
            const unsubscribe = await relationshipAdvisorClient.start({
                requestId,
                messages: requestMessages,
                imageRefs,
            }, onEvent);
            if (terminalEventReceived || !mountedRef.current || cancelledRequestIdsRef.current.has(requestId)) {
                unsubscribe();
            } else {
                unsubscribeRef.current = unsubscribe;
            }
            if (cancelledRequestIdsRef.current.has(requestId)) {
                relationshipAdvisorClient.cancel(requestId);
                return true;
            }
            return true;
        } catch {
            const wasCancelled = cancelledRequestIdsRef.current.has(requestId);
            if (providerStartedRequestIdRef.current === requestId) {
                relationshipAdvisorClient.cancel(requestId);
            }
            await discardRelationshipAdvisorImages(imageRefs).catch(() => undefined);
            if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = null;
            providerStartedRequestIdRef.current = null;
            cancelledRequestIdsRef.current.delete(requestId);
            if (mountedRef.current) {
                dispatch(wasCancelled
                    ? { type: 'cancel-before-start', requestId }
                    : {
                        type: 'fail-before-start',
                        requestId,
                        error: 'Relationship advisor is temporarily unavailable',
                    });
                if (!wasCancelled) setCanRetry(true);
            }
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
            return false;
        }
    }, [state.messages]);

    const cancel = React.useCallback(() => {
        const requestId = activeRequestIdRef.current;
        if (!requestId) return;
        cancelledRequestIdsRef.current.add(requestId);
        if (providerStartedRequestIdRef.current === requestId) {
            relationshipAdvisorClient.cancel(requestId);
        } else {
            activeRequestIdRef.current = null;
            dispatch({ type: 'cancel-before-start', requestId });
        }
    }, []);

    const clear = React.useCallback(() => {
        if (!state.activeRequestId) {
            lastAttemptRef.current = null;
            setCanRetry(false);
            dispatch({ type: 'reset', messages: [] });
        }
    }, [state.activeRequestId]);

    const retry = React.useCallback(async () => {
        const attempt = lastAttemptRef.current;
        if (!attempt || activeRequestIdRef.current) return false;
        const latest = state.messages.at(-1);
        const reuseLastUser = latest?.role === 'user'
            && latest.text === attempt.text
            && latest.imageCount === attempt.images.length;
        return send(attempt.text, attempt.images, { reuseLastUser });
    }, [send, state.messages]);

    return { ...state, send, cancel, clear, canRetry, retry };
}
