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
 * Groups all tool-call messages within a single turn (user message →
 * next user message) into one collapsible ToolGroupItem. Text messages
 * always pass through as standalone TextItems.
 *
 * The messages array is newest-first (inverted FlatList). The group is
 * placed at the position of the chronologically-first tool call in the
 * turn (highest array index) so that agent text before / after tools
 * keeps its natural position. Group IDs are derived from the oldest
 * tool in each turn for stability as new messages prepend.
 *
 * When `enabled` is false (user disabled grouping in settings), every
 * message passes through as a standalone TextItem.
 */
export function useGroupedMessages(messages: Message[], enabled: boolean = true): DisplayItem[] {
    return React.useMemo(() => {
        if (!enabled) {
            return messages.map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
        }

        // Step 1: assign each message to a turn (newest-first → turn 0 = current)
        const turnOf = new Array<number>(messages.length);
        let turn = 0;
        for (let i = 0; i < messages.length; i++) {
            turnOf[i] = turn;
            if (messages[i].kind === 'user-text') turn++;
        }

        // Step 2: collect visible tool-call messages per turn, track oldest index
        const turnTools = new Map<number, { msgs: Message[]; oldestIdx: number }>();
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.kind !== 'tool-call') continue;
            if (isInvisibleMessage(msg) || isUserAttachment(msg)) continue;
            const t = turnOf[i];
            let info = turnTools.get(t);
            if (!info) {
                info = { msgs: [], oldestIdx: i };
                turnTools.set(t, info);
            }
            info.msgs.push(msg);
            info.oldestIdx = i; // keeps updating → ends up as highest index = oldest
        }

        // Step 3: build display items — group emitted at oldest tool position
        const result: DisplayItem[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            if (isInvisibleMessage(msg)) continue;

            if (isUserAttachment(msg)) {
                result.push({ type: 'message', id: msg.id, message: msg });
                continue;
            }

            if (msg.kind === 'tool-call') {
                const info = turnTools.get(turnOf[i]);
                if (info && i === info.oldestIdx) {
                    let hasRunning = false;
                    for (const m of info.msgs) {
                        if (m.kind === 'tool-call' && m.tool.state === 'running') {
                            hasRunning = true;
                            break;
                        }
                    }
                    result.push({
                        type: 'tool-group',
                        id: `group-${info.msgs[info.msgs.length - 1].id}`,
                        messages: info.msgs,
                        hasRunning,
                    });
                }
                // All tool calls consumed by their turn group — skip standalone
                continue;
            }

            // Standalone messages (user text, agent text, events)
            result.push({ type: 'message', id: msg.id, message: msg });
        }

        return result;
    }, [messages, enabled]);
}

/** Returns true for messages that render as null and should be excluded entirely */
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
