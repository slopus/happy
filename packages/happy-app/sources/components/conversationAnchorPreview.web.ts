import type { DisplayItem } from '@/hooks/useGroupedMessages';
import type { UserMessageAnchor } from '@/hooks/useUserMessageAnchors';
import { parseMarkdown } from './markdown/parseMarkdown';

/** Parse only the hovered turn, and bound work even for very long responses. */
function plainText(text: string): string {
    return parseMarkdown(text.slice(0, 1500)).map(block => {
        switch (block.type) {
            case 'text': case 'header': return block.content.map(span => span.text).join('');
            case 'list': case 'numbered-list': return block.items.map(item => item.spans.map(span => span.text).join('')).join(' ');
            case 'code-block': case 'mermaid': return block.content;
            case 'image': return block.alt;
            case 'table': return [...block.headers, ...block.rows.flat()].map(cell => cell.map(span => span.text).join('')).join(' ');
            default: return '';
        }
    }).join(' ').replace(/\s+/g, ' ').trim();
}

export function conversationAnchorPreview(anchor: UserMessageAnchor, items: DisplayItem[]) {
    let reply = '';
    // Items are newest-first. Walk forward in time until the next prompt,
    // retaining the final assistant text rather than an intermediate update.
    for (let index = anchor.displayIndex - 1; index >= 0; index--) {
        const item = items[index];
        if (item.type === 'message' && item.message.kind === 'user-text') break;
        const messages = item.type === 'message' ? [item.message] : item.messages;
        for (const message of messages) {
            if (message.kind === 'agent-text' && message.text.trim()) reply = message.text;
        }
    }
    return { prompt: plainText(anchor.text), reply: plainText(reply) };
}
