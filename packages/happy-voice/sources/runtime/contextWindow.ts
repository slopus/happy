import { llm } from '@livekit/agents';

function isChatMessage(item: llm.ChatItem): item is llm.ChatMessage {
    return item.type === 'message';
}

function stripOptionsBlocks(text: string): string {
    return text.replace(/<options>[\s\S]*?<\/options>/gi, '').trim();
}

export function chatMessageText(message: llm.ChatMessage): string {
    const parts = message.content.map((c) => {
        if (typeof c === 'string') {
            return c;
        }
        if (c && typeof c === 'object' && 'text' in c) {
            const value = (c as { text?: unknown }).text;
            return typeof value === 'string' ? value : '';
        }
        return '';
    });
    return parts.join('');
}

export function looksLikeAppContextUpdate(message: llm.ChatMessage): boolean {
    return message.role === 'system';
}

export function extractRecentVoiceMessages(params: {
    chatCtx: llm.ChatContext;
    maxMessages: number;
    maxChars: number;
    excludeLatestUserMessage?: boolean;
}): string {
    let latestUserMessage: llm.ChatMessage | null = null;
    if (params.excludeLatestUserMessage) {
        for (let i = params.chatCtx.items.length - 1; i >= 0; i--) {
            const item = params.chatCtx.items[i];
            if (!item || item.type !== 'message') continue;
            if (item.role !== 'user') continue;
            latestUserMessage = item;
            break;
        }
    }

    const messages = params.chatCtx.items
        .filter(isChatMessage)
        .filter((m) => !latestUserMessage || m !== latestUserMessage)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
            const label = m.role === 'user' ? 'User' : 'Assistant';
            return `${label}: ${chatMessageText(m).trim()}`;
        })
        .filter((line) => line !== 'User:' && line !== 'Assistant:' && line.trim().length > 0);

    const picked = messages
        .slice(-Math.max(0, params.maxMessages));
    let result = picked.join('\n');
    if (result.length > params.maxChars) {
        result = result.slice(result.length - params.maxChars);
    }
    return result.trim();
}

export function extractRecentAppContext(params: {
    chatCtx: llm.ChatContext;
    maxMessages: number;
    maxChars: number;
}): string {
    const updates: string[] = [];
    let firstSystemSeen = false;
    for (const item of params.chatCtx.items) {
        if (!isChatMessage(item)) continue;
        if (!looksLikeAppContextUpdate(item)) continue;
        if (!firstSystemSeen) {
            // The first system message is the current rendered prompt template.
            firstSystemSeen = true;
            continue;
        }
        const text = stripOptionsBlocks(chatMessageText(item).trim());
        if (text) {
            updates.push(text);
        }
    }

    const picked = updates
        .slice(-Math.max(0, params.maxMessages));
    let result = picked.join('\n\n');
    if (result.length > params.maxChars) {
        result = result.slice(result.length - params.maxChars);
    }
    return result.trim();
}

export function extractRecentTextUpdates(params: {
    updates: string[];
    maxMessages: number;
    maxChars: number;
    joinWith?: string;
}): string {
    const joinWith = params.joinWith ?? '\n\n';
    const picked = params.updates
        .map((u) => (typeof u === 'string' ? stripOptionsBlocks(u.trim()) : ''))
        .filter(Boolean)
        .slice(-Math.max(0, params.maxMessages));
    let result = picked.join(joinWith);
    if (result.length > params.maxChars) {
        result = result.slice(result.length - params.maxChars);
    }
    return result.trim();
}
