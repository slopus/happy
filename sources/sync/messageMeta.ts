import type { MessageMeta } from './typesMessageMeta';

export function buildOutgoingMessageMeta(params: {
    sentFrom: string;
    permissionMode: NonNullable<MessageMeta['permissionMode']>;
    model?: MessageMeta['model'];
    fallbackModel?: MessageMeta['fallbackModel'];
    appendSystemPrompt: string;
    displayText?: string;
}): MessageMeta {
    return {
        sentFrom: params.sentFrom,
        permissionMode: params.permissionMode,
        appendSystemPrompt: params.appendSystemPrompt,
        ...(params.displayText !== undefined ? { displayText: params.displayText } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.fallbackModel !== undefined ? { fallbackModel: params.fallbackModel } : {}),
    };
}
