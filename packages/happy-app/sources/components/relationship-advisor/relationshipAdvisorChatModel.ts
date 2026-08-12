import type { RelationshipAdvisorEvent } from '@/sync/relationshipAdvisorClient';

export interface RelationshipAdvisorChatMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    createdAt: number;
    imageCount: number;
}

export interface RelationshipAdvisorChatState {
    messages: RelationshipAdvisorChatMessage[];
    activeRequestId: string | null;
    streamingText: string;
    error: string | null;
}

export type RelationshipAdvisorChatAction =
    | { type: 'start'; requestId: string; message: RelationshipAdvisorChatMessage; appendMessage?: boolean }
    | { type: 'cancel-before-start'; requestId: string }
    | { type: 'fail-before-start'; requestId: string; error: string }
    | { type: 'event'; event: RelationshipAdvisorEvent; completedAt?: number }
    | { type: 'reset'; messages: RelationshipAdvisorChatMessage[] };

export function shouldShowRelationshipAdvisorEmptyState(state: RelationshipAdvisorChatState): boolean {
    return state.messages.length === 0 && !state.activeRequestId && !state.error;
}

export function relationshipAdvisorChatReducer(
    state: RelationshipAdvisorChatState,
    action: RelationshipAdvisorChatAction,
): RelationshipAdvisorChatState {
    if (action.type === 'reset') {
        return {
            messages: action.messages,
            activeRequestId: null,
            streamingText: '',
            error: null,
        };
    }

    if (action.type === 'start') {
        return {
            messages: action.appendMessage === false
                ? state.messages
                : [...state.messages.slice(-49), action.message],
            activeRequestId: action.requestId,
            streamingText: '',
            error: null,
        };
    }

    if (action.type === 'cancel-before-start' || action.type === 'fail-before-start') {
        if (state.activeRequestId !== action.requestId) return state;
        return {
            messages: state.messages.filter((message) => message.id !== `user-${action.requestId}`),
            activeRequestId: null,
            streamingText: '',
            error: action.type === 'fail-before-start' ? action.error : null,
        };
    }

    if (action.event.requestId !== state.activeRequestId) return state;
    if (action.event.type === 'accepted') return state;
    if (action.event.type === 'delta') {
        return { ...state, streamingText: state.streamingText + action.event.text };
    }
    if (action.event.type === 'error') {
        const partialMessage: RelationshipAdvisorChatMessage | null = state.streamingText
            ? {
                id: `assistant-${action.event.requestId}`,
                role: 'assistant',
                text: state.streamingText,
                createdAt: action.completedAt ?? Date.now(),
                imageCount: 0,
            }
            : null;
        return {
            ...state,
            messages: partialMessage ? [...state.messages.slice(-49), partialMessage] : state.messages,
            activeRequestId: null,
            streamingText: '',
            error: action.event.error,
        };
    }

    const assistantMessage: RelationshipAdvisorChatMessage | null = state.streamingText
        ? {
            id: `assistant-${action.event.requestId}`,
            role: 'assistant',
            text: state.streamingText,
            createdAt: action.completedAt ?? Date.now(),
            imageCount: 0,
        }
        : null;
    return {
        messages: assistantMessage ? [...state.messages.slice(-49), assistantMessage] : state.messages,
        activeRequestId: null,
        streamingText: '',
        error: null,
    };
}
