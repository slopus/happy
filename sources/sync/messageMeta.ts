import type { MessageMeta } from './typesMessageMeta';

export function buildOutgoingMessageMeta(params: {
    sentFrom: string;
    permissionMode: NonNullable<MessageMeta['permissionMode']>;
    appendSystemPrompt: string;
    displayText?: string;
}): MessageMeta {
    return {
        sentFrom: params.sentFrom,
        permissionMode: params.permissionMode,
        appendSystemPrompt: params.appendSystemPrompt,
        ...(params.displayText ? { displayText: params.displayText } : {}),
    };
}
