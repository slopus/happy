import type { RelationshipAdvisorChatMessage } from './relationshipAdvisorChatModel';

export const MAX_RELATIONSHIP_ADVISOR_CONVERSATIONS = 30;
export const MAX_RELATIONSHIP_ADVISOR_MESSAGES = 50;
export const MAX_RELATIONSHIP_ADVISOR_HISTORY_CHARACTERS = 250_000;

export interface RelationshipAdvisorConversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: RelationshipAdvisorChatMessage[];
}

export function createRelationshipAdvisorConversation(
    id: string,
    title: string,
    now = Date.now(),
): RelationshipAdvisorConversation {
    return { id, title, createdAt: now, updatedAt: now, messages: [] };
}

export function buildRelationshipAdvisorConversationTitle(
    messages: RelationshipAdvisorChatMessage[],
    fallback = '',
): string {
    const source = messages.find((message) => message.role === 'user' && message.text.trim())?.text ?? fallback;
    const compact = source.replace(/\s+/g, ' ').trim();
    if (!compact) return fallback;
    return compact.length > 36 ? `${compact.slice(0, 36).trimEnd()}...` : compact;
}

export function saveRelationshipAdvisorConversation(
    conversations: RelationshipAdvisorConversation[],
    conversation: RelationshipAdvisorConversation,
): RelationshipAdvisorConversation[] {
    return limitRelationshipAdvisorConversations(
        [conversation, ...conversations.filter(({ id }) => id !== conversation.id)]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_RELATIONSHIP_ADVISOR_CONVERSATIONS),
    );
}

export function limitRelationshipAdvisorConversations(
    conversations: RelationshipAdvisorConversation[],
): RelationshipAdvisorConversation[] {
    let remaining = MAX_RELATIONSHIP_ADVISOR_HISTORY_CHARACTERS;
    return conversations.slice(0, MAX_RELATIONSHIP_ADVISOR_CONVERSATIONS).map((conversation) => {
        remaining = Math.max(0, remaining - conversation.title.length);
        const messages: RelationshipAdvisorChatMessage[] = [];
        for (const message of conversation.messages.slice(-MAX_RELATIONSHIP_ADVISOR_MESSAGES).reverse()) {
            if (message.text.length > remaining) {
                remaining = 0;
                break;
            }
            messages.push(message);
            remaining -= message.text.length;
        }
        return { ...conversation, messages: messages.reverse() };
    });
}

export function removeRelationshipAdvisorConversation(
    conversations: RelationshipAdvisorConversation[],
    conversationId: string,
): RelationshipAdvisorConversation[] {
    return conversations.filter(({ id }) => id !== conversationId);
}
