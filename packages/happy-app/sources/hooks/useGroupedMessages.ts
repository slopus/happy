import * as React from 'react';
import { Message } from '@/sync/typesMessage';
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
    hasPendingPermission: boolean;
};

export type AgentWorkGroupItem = {
    type: 'agent-work-group';
    id: string;
    messages: Message[];
    hasRunning: boolean;
    hasPendingPermission: boolean;
    startedAt: number;
    completedAt: number | null;
};

export type ToolDisplayItem = TextItem | ToolGroupItem;
export type DisplayItem = TextItem | ToolGroupItem | AgentWorkGroupItem;

/**
 * The messages array is newest-first for the inverted FlatList.
 *
 * When enabled, intermediate agent work in a turn is collapsed into an
 * AgentWorkGroupItem while the final agent text remains visible. Tool calls
 * that remain outside a work group are collapsed only when adjacent visible
 * tool calls form a run. When disabled, every message passes through.
 */
export function useGroupedMessages(
    messages: Message[],
    enabled: boolean = true,
    options: { collapseCurrentTurn?: boolean } = {},
): DisplayItem[] {
    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    return React.useMemo(() => {
        return groupMessagesForDisplay(messages, enabled, { collapseCurrentTurn });
    }, [messages, enabled, collapseCurrentTurn]);
}

export function groupMessagesForDisplay(
    messages: Message[],
    enabled: boolean = true,
    options: { collapseCurrentTurn?: boolean } = {},
): DisplayItem[] {
    if (!enabled) {
        return messages.map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
    }

    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    const turnOf = getTurnAssignments(messages);
    const workGroups = collectAgentWorkGroups(messages, turnOf, collapseCurrentTurn);
    const hiddenWorkIndexes = new Set<number>();
    const workGroupByOldestIndex = new Map<number, AgentWorkGroupItem>();

    for (const group of workGroups) {
        workGroupByOldestIndex.set(group.oldestIdx, group.item);
        for (const index of group.hiddenIndexes) {
            hiddenWorkIndexes.add(index);
        }
    }

    const visibleForToolGrouping = (msg: Message, index: number): boolean => {
        if (hiddenWorkIndexes.has(index)) return false;
        if (isInvisibleMessage(msg) || isUserAttachment(msg)) return false;
        return msg.kind === 'tool-call';
    };

    const toolRuns = collectToolRuns(messages, visibleForToolGrouping);

    // Build display items — groups are emitted at their oldest hidden member
    // so the visual order remains user message → collapsed work → final answer.
    const result: DisplayItem[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (isInvisibleMessage(msg)) continue;

        if (hiddenWorkIndexes.has(i)) {
            const workGroup = workGroupByOldestIndex.get(i);
            if (workGroup) {
                result.push(workGroup);
            }
            continue;
        }

        if (isUserAttachment(msg)) {
            result.push({ type: 'message', id: msg.id, message: msg });
            continue;
        }

        if (msg.kind === 'tool-call') {
            const info = toolRuns.get(i);
            if (info && info.msgs.length > 1 && i === info.oldestIdx) {
                let hasRunning = false;
                for (const m of info.msgs) {
                    if (m.kind === 'tool-call' && m.tool.state === 'running') {
                        hasRunning = true;
                        break;
                    }
                }
                const chronologicalMessages = [...info.msgs].reverse();
                result.push({
                    type: 'tool-group',
                    id: `group-${chronologicalMessages[0].id}`,
                    messages: chronologicalMessages,
                    hasRunning,
                    hasPendingPermission: hasPendingPermission(info.msgs),
                });
            }
            if (info && info.msgs.length > 1) {
                continue;
            }
        }

        // Standalone messages (user text, agent text, events)
        result.push({ type: 'message', id: msg.id, message: msg });
    }

    return result;
}

export function groupToolCallsForDisplay(
    messages: Message[],
    enabled: boolean = true,
    options: { groupSingleToolCalls?: boolean } = {},
): ToolDisplayItem[] {
    if (!enabled) {
        return messages.map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
    }

    const groupSingleToolCalls = options.groupSingleToolCalls ?? false;
    const toolRuns = collectToolRuns(messages, (msg) => {
        if (msg.kind !== 'tool-call') return false;
        if (isInvisibleMessage(msg) || isUserAttachment(msg)) return false;
        return true;
    });

    const result: ToolDisplayItem[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (isInvisibleMessage(msg)) continue;

        if (isUserAttachment(msg)) {
            result.push({ type: 'message', id: msg.id, message: msg });
            continue;
        }

        if (msg.kind === 'tool-call') {
            const info = toolRuns.get(i);
            const shouldGroupRun = info && (info.msgs.length > 1 || groupSingleToolCalls);
            if (shouldGroupRun && i === info.oldestIdx) {
                let hasRunning = false;
                for (const m of info.msgs) {
                    if (m.kind === 'tool-call' && m.tool.state === 'running') {
                        hasRunning = true;
                        break;
                    }
                }
                const chronologicalMessages = [...info.msgs].reverse();
                result.push({
                    type: 'tool-group',
                    id: `group-${chronologicalMessages[0].id}`,
                    messages: chronologicalMessages,
                    hasRunning,
                    hasPendingPermission: hasPendingPermission(info.msgs),
                });
            }
            if (shouldGroupRun) {
                continue;
            }
        }

        result.push({ type: 'message', id: msg.id, message: msg });
    }

    return result;
}

function getTurnAssignments(messages: Message[]): number[] {
    // Newest-first → turn 0 is the current assistant turn.
    const turnOf = new Array<number>(messages.length);
    let turn = 0;
    for (let i = 0; i < messages.length; i++) {
        turnOf[i] = turn;
        if (messages[i].kind === 'user-text') turn++;
    }
    return turnOf;
}

function collectToolRuns(
    messages: Message[],
    shouldInclude: (msg: Message, index: number) => boolean,
): Map<number, { msgs: Message[]; oldestIdx: number }> {
    const runsByIndex = new Map<number, { msgs: Message[]; oldestIdx: number }>();
    let current: { indexes: number[]; msgs: Message[] } | null = null;

    const flush = () => {
        if (!current || current.msgs.length === 0) {
            current = null;
            return;
        }
        const oldestIdx = current.indexes[current.indexes.length - 1];
        const run = { msgs: current.msgs, oldestIdx };
        for (const index of current.indexes) {
            runsByIndex.set(index, run);
        }
        current = null;
    };

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!shouldInclude(msg, i)) {
            if (!isInvisibleMessage(msg)) {
                flush();
            }
            continue;
        }
        if (!current) {
            current = { indexes: [], msgs: [] };
        }
        current.indexes.push(i);
        current.msgs.push(msg);
    }
    flush();

    return runsByIndex;
}

function collectAgentWorkGroups(messages: Message[], turnOf: number[], collapseCurrentTurn: boolean): Array<{
    item: AgentWorkGroupItem;
    hiddenIndexes: number[];
    oldestIdx: number;
}> {
    const segments = new Map<number, number[]>();
    for (let i = 0; i < messages.length; i++) {
        const turn = turnOf[i];
        if (!segments.has(turn)) {
            segments.set(turn, []);
        }
        segments.get(turn)!.push(i);
    }

    const groups: Array<{
        item: AgentWorkGroupItem;
        hiddenIndexes: number[];
        oldestIdx: number;
    }> = [];

    for (const [turn, indexes] of segments) {
        if (turn === 0 && !collapseCurrentTurn) {
            continue;
        }

        const visibleAgentIndexes = indexes.filter((index) => {
            const msg = messages[index];
            if (msg.kind === 'user-text') return false;
            if (isInvisibleMessage(msg) || isUserAttachment(msg)) return false;
            return true;
        });

        const finalTextIndex = visibleAgentIndexes.find((index) => messages[index].kind === 'agent-text');
        if (finalTextIndex === undefined) continue;

        const hiddenIndexes = visibleAgentIndexes.filter((index) => index > finalTextIndex);
        if (hiddenIndexes.length === 0) continue;

        const oldestIdx = Math.max(...hiddenIndexes);
        const hiddenMessages = hiddenIndexes.map((index) => messages[index]);
        const startedAt = Math.min(...hiddenMessages.map((msg) => msg.createdAt));
        const completedAt = messages[finalTextIndex].createdAt;

        groups.push({
            hiddenIndexes,
            oldestIdx,
            item: {
                type: 'agent-work-group',
                id: `work-${messages[oldestIdx].id}`,
                messages: hiddenMessages,
                hasRunning: false,
                hasPendingPermission: hasPendingPermission(hiddenMessages),
                startedAt,
                completedAt,
            },
        });
    }

    return groups;
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

function hasPendingPermission(messages: Message[]): boolean {
    return messages.some((msg) => (
        msg.kind === 'tool-call'
        && msg.tool.permission?.status === 'pending'
    ));
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

export function formatWorkDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m${seconds}s`;
    }
    return `${seconds}s`;
}
