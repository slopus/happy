import * as React from 'react';
import { Message } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { t } from '@/text';

// Display item types for the grouped message list
export type TextItem = {
    type: 'message';
    id: string;
    message: Message;
};

export type ToolGroupItem = {
    type: 'tool-group';
    id: string;
    messages: Message[];
    hasRunning: boolean;
};

export type DisplayItem = TextItem | ToolGroupItem;

/**
 * Groups consecutive non-text messages (tool calls, thinking, events) into
 * collapsible ToolGroupItems. Text messages pass through as TextItems.
 *
 * The messages array is newest-first (inverted FlatList). Group IDs are
 * derived from the last message in each group (oldest chronologically)
 * for stability as new messages prepend.
 *
 * When `enabled` is false (user disabled grouping in settings), every
 * message passes through as a standalone TextItem — restoring the
 * pre-grouping behavior where MessageView renders each message (and
 * returns null for hidden tools/thinking) on its own.
 */
export function useGroupedMessages(messages: Message[], enabled: boolean = true): DisplayItem[] {
    return React.useMemo(() => {
        if (!enabled) {
            return messages.map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
        }

        const result: DisplayItem[] = [];
        let buffer: Message[] = [];

        const flushBuffer = () => {
            if (buffer.length === 0) return;

            let hasRunning = false;
            for (const msg of buffer) {
                if (msg.kind === 'tool-call' && msg.tool.state === 'running') {
                    hasRunning = true;
                    break;
                }
            }

            result.push({
                type: 'tool-group',
                id: `group-${buffer[buffer.length - 1].id}`,
                messages: buffer,
                hasRunning,
            });
            buffer = [];
        };

        for (const msg of messages) {
            if (isStandaloneMessage(msg) || isUserAttachment(msg)) {
                flushBuffer();
                result.push({ type: 'message', id: msg.id, message: msg });
            } else if (isInvisibleMessage(msg)) {
                // Skip messages that render as null (hidden tools, thinking, empty text)
                continue;
            } else {
                buffer.push(msg);
            }
        }

        flushBuffer();
        return result;
    }, [messages, enabled]);
}

/** Returns true for messages that should NOT be grouped (displayed standalone) */
function isStandaloneMessage(msg: Message): boolean {
    if (msg.kind === 'user-text') return true;
    if (msg.kind === 'agent-event') return true; // Mode switches, "aborted by user", etc.
    if (msg.kind === 'agent-text') {
        // Thinking messages go into groups, non-empty text stands alone
        if (msg.isThinking) return false;
        if (msg.text.trim().length === 0) return false;
        return true;
    }
    return false;
}

/** Returns true for messages that render as null and should be excluded from groups */
function isInvisibleMessage(msg: Message): boolean {
    // Hidden tools (ToolSearch, CodexReasoning, etc.)
    if (msg.kind === 'tool-call') {
        const known = knownTools[msg.tool.name as keyof typeof knownTools] as any;
        return known?.hidden === true;
    }
    // Thinking messages render as null in MessageView
    if (msg.kind === 'agent-text') {
        if (msg.isThinking) return true;
        if (msg.text.trim().length === 0) return true;
    }
    return false;
}

/** User-sent file/image attachments should never be collapsed into a group */
function isUserAttachment(msg: Message): boolean {
    return msg.kind === 'tool-call' && msg.tool.name === 'file';
}

// Tool name → category mapping for summary generation
const TOOL_CATEGORIES: Record<string, string> = {
    Edit: 'edit', MultiEdit: 'edit', Write: 'edit',
    CodexPatch: 'edit', GeminiPatch: 'edit', edit: 'edit', NotebookEdit: 'edit',
    Read: 'read', read: 'read', NotebookRead: 'read',
    Bash: 'terminal', CodexBash: 'terminal', GeminiBash: 'terminal',
    shell: 'terminal', execute: 'terminal',
    Grep: 'search', Glob: 'search', LS: 'search', search: 'search', WebSearch: 'search',
    WebFetch: 'web',
    Task: 'task', Agent: 'task',
};

/** Generate a human-readable summary of tools in a group */
export function generateGroupSummary(messages: Message[]): string {
    const counts: Record<string, number> = {};

    for (const msg of messages) {
        if (msg.kind === 'tool-call') {
            const category = TOOL_CATEGORIES[msg.tool.name] || 'other';
            counts[category] = (counts[category] || 0) + 1;
        }
    }

    const parts: string[] = [];

    if (counts.edit) parts.push(t('toolGroup.editedFiles', { count: counts.edit }));
    if (counts.read) parts.push(t('toolGroup.readFiles', { count: counts.read }));
    if (counts.terminal) parts.push(t('toolGroup.ranCommands', { count: counts.terminal }));
    if (counts.search) parts.push(t('toolGroup.searched', { count: counts.search }));
    if (counts.web) parts.push(t('toolGroup.fetchedUrls', { count: counts.web }));
    if (counts.task) parts.push(t('toolGroup.ranTasks', { count: counts.task }));
    if (counts.other) parts.push(t('toolGroup.usedTools', { count: counts.other }));

    return parts.join(', ') || t('toolGroup.usedTools', { count: messages.length });
}
