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

type GroupedMessagesCache = {
    enabled: boolean;
    messages: Message[];
    displayItems: DisplayItem[];
};

type MessageDisplayRole = 'standalone' | 'groupable' | 'invisible';

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
    const cacheRef = React.useRef<GroupedMessagesCache | null>(null);

    return React.useMemo(() => {
        const cached = cacheRef.current;
        const displayItems = tryIncrementalGroupedMessages(cached, messages, enabled)
            ?? groupMessages(messages, enabled);

        cacheRef.current = { enabled, messages, displayItems };
        return displayItems;
    }, [messages, enabled]);
}

export function groupMessages(messages: Message[], enabled: boolean = true): DisplayItem[] {
    if (!enabled) {
        return messages.map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
    }

    const result: DisplayItem[] = [];
    let buffer: Message[] = [];

    const flushBuffer = () => {
        if (buffer.length === 0) return;
        result.push(createToolGroupItem(buffer));
        buffer = [];
    };

    for (const msg of messages) {
        const role = getMessageDisplayRole(msg);
        if (role === 'standalone') {
            flushBuffer();
            result.push({ type: 'message', id: msg.id, message: msg });
        } else if (role === 'invisible') {
            // Skip messages that render as null (hidden tools, thinking, empty text)
            continue;
        } else {
            buffer.push(msg);
        }
    }

    flushBuffer();
    return result;
}

function tryIncrementalGroupedMessages(
    cached: GroupedMessagesCache | null,
    messages: Message[],
    enabled: boolean,
): DisplayItem[] | null {
    if (!cached || cached.enabled !== enabled) {
        return null;
    }
    if (cached.messages === messages) {
        return cached.displayItems;
    }
    if (!enabled) {
        return tryIncrementalUngroupedMessages(cached, messages);
    }

    const latestUpdate = tryUpdateNewestMessage(cached, messages);
    if (latestUpdate) {
        return latestUpdate;
    }

    return tryPrependNewestMessages(cached, messages);
}

function tryIncrementalUngroupedMessages(
    cached: GroupedMessagesCache,
    messages: Message[],
): DisplayItem[] | null {
    const previousMessages = cached.messages;
    if (messages.length === previousMessages.length && messages.length > 0) {
        if (messages[0]?.id === previousMessages[0]?.id && (messages.length === 1 || messages[1] === previousMessages[1])) {
            const first = { type: 'message', id: messages[0].id, message: messages[0] } as TextItem;
            return [first, ...cached.displayItems.slice(1)];
        }
    }

    const prependedCount = getPrependedCount(previousMessages, messages);
    if (prependedCount > 0) {
        const added = messages
            .slice(0, prependedCount)
            .map((message) => ({ type: 'message', id: message.id, message }) as TextItem);
        return [...added, ...cached.displayItems];
    }

    return null;
}

function tryUpdateNewestMessage(
    cached: GroupedMessagesCache,
    messages: Message[],
): DisplayItem[] | null {
    const previousMessages = cached.messages;
    if (messages.length !== previousMessages.length || messages.length === 0) {
        return null;
    }
    if (messages[0]?.id !== previousMessages[0]?.id) {
        return null;
    }
    if (messages.length > 1 && messages[1] !== previousMessages[1]) {
        return null;
    }

    const previousMessage = previousMessages[0];
    const nextMessage = messages[0];
    if (!previousMessage || !nextMessage) {
        return cached.displayItems;
    }

    const previousRole = getMessageDisplayRole(previousMessage);
    const nextRole = getMessageDisplayRole(nextMessage);
    if (previousRole !== nextRole) {
        return null;
    }

    if (nextRole === 'invisible') {
        return cached.displayItems;
    }

    const [firstItem, ...rest] = cached.displayItems;
    if (!firstItem) {
        return null;
    }

    if (nextRole === 'standalone') {
        if (firstItem.type !== 'message' || firstItem.message.id !== nextMessage.id) {
            return null;
        }
        return [{ ...firstItem, message: nextMessage }, ...rest];
    }

    if (firstItem.type !== 'tool-group') {
        return null;
    }
    const messageIndex = firstItem.messages.findIndex((message) => message.id === nextMessage.id);
    if (messageIndex < 0) {
        return null;
    }

    const nextGroupMessages = firstItem.messages.slice();
    nextGroupMessages[messageIndex] = nextMessage;
    return [
        createToolGroupItem(nextGroupMessages),
        ...rest,
    ];
}

function tryPrependNewestMessages(
    cached: GroupedMessagesCache,
    messages: Message[],
): DisplayItem[] | null {
    const previousMessages = cached.messages;
    const prependedCount = getPrependedCount(previousMessages, messages);
    if (prependedCount <= 0) {
        return null;
    }

    const addedItems = groupMessages(messages.slice(0, prependedCount), true);
    if (addedItems.length === 0) {
        return cached.displayItems;
    }

    return mergeDisplayItemBoundary(addedItems, cached.displayItems);
}

function getPrependedCount(previousMessages: Message[], messages: Message[]): number {
    if (previousMessages.length === 0 || messages.length <= previousMessages.length) {
        return 0;
    }

    // Realtime batches are small. If we cannot find the old newest message
    // quickly, this is likely a pagination/reload shape and should use the
    // safer full regroup path.
    const maxProbe = Math.min(messages.length - previousMessages.length, 50);
    for (let count = 1; count <= maxProbe; count++) {
        if (messages[count] === previousMessages[0]) {
            return count;
        }
    }
    return 0;
}

function mergeDisplayItemBoundary(newerItems: DisplayItem[], olderItems: DisplayItem[]): DisplayItem[] {
    if (newerItems.length === 0) {
        return olderItems;
    }
    if (olderItems.length === 0) {
        return newerItems;
    }

    const lastNewer = newerItems[newerItems.length - 1];
    const firstOlder = olderItems[0];
    if (lastNewer?.type !== 'tool-group' || firstOlder?.type !== 'tool-group') {
        return [...newerItems, ...olderItems];
    }

    const mergedGroup = createToolGroupItem([
        ...lastNewer.messages,
        ...firstOlder.messages,
    ]);
    return [
        ...newerItems.slice(0, -1),
        mergedGroup,
        ...olderItems.slice(1),
    ];
}

function createToolGroupItem(messages: Message[]): ToolGroupItem {
    let hasRunning = false;
    for (const msg of messages) {
        if (msg.kind === 'tool-call' && msg.tool.state === 'running') {
            hasRunning = true;
            break;
        }
    }

    return {
        type: 'tool-group',
        id: `group-${messages[messages.length - 1].id}`,
        messages,
        hasRunning,
    };
}

function getMessageDisplayRole(msg: Message): MessageDisplayRole {
    if (isStandaloneMessage(msg) || isUserAttachment(msg)) {
        return 'standalone';
    }
    if (isInvisibleMessage(msg)) {
        return 'invisible';
    }
    return 'groupable';
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
