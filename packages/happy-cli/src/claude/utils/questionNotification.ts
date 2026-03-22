import type { SDKAssistantMessage, SDKMessage } from '../sdk';

export function getAskUserQuestionToolCallIds(message: SDKMessage): string[] {
    if (message.type !== 'assistant') {
        return [];
    }

    const assistantMessage = message as SDKAssistantMessage;
    const content = assistantMessage.message.content;
    if (!Array.isArray(content)) {
        return [];
    }

    const ids: string[] = [];
    for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && typeof block.id === 'string' && block.id.length > 0) {
            ids.push(block.id);
        }
    }
    return ids;
}
