import * as React from 'react';
import { Message } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';
import { isInteractiveQuestionToolName } from '@/utils/toolDisplay';
import { assignTurns } from '@/utils/agentTurns';

// Display item types for the grouped message list
export type TextItem = {
    type: 'message';
    id: string;
    message: Message;
};

export type AgentWorkGroupItem = {
    type: 'agent-work-group';
    id: string;
    /** Stable identity of the user prompt that opened this turn. */
    turnUserMessageId: string | null;
    /** Hidden intermediate messages, in chronological (render) order. */
    messages: Message[];
    hasRunning: boolean;
    hasPendingPermission: boolean;
    startedAt: number;
    completedAt: number | null;
};

export type DisplayItem = TextItem | AgentWorkGroupItem;

/**
 * The messages array arrives newest-first (that is how sync stores it); the
 * returned display items are chronological, ready for a top-to-bottom list.
 *
 * Grouping is single-level on purpose: while a turn is streaming every message
 * renders flat, and once the turn completes its intermediate work collapses
 * into one AgentWorkGroupItem above the final answer. There is no grouping of
 * adjacent tool calls — an expanded work group renders its members exactly as
 * they looked while streaming. When disabled, every message passes through.
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
        const flat = messages
            .filter((msg) => !isInvisibleMessage(msg))
            .map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
        flat.reverse();
        return flat;
    }

    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    // Newest-first → turn 0 is the current assistant turn.
    const turnOf = assignTurns(messages);
    const workGroups = collectAgentWorkGroups(messages, turnOf, collapseCurrentTurn);
    const hiddenWorkIndexes = new Set<number>();
    const workGroupByOldestIndex = new Map<number, AgentWorkGroupItem>();

    for (const group of workGroups) {
        workGroupByOldestIndex.set(group.oldestIdx, group.item);
        for (const index of group.hiddenIndexes) {
            hiddenWorkIndexes.add(index);
        }
    }

    // Build newest-first, matching the input order, then reverse once at the
    // end. Groups are emitted at their oldest hidden member so the final order
    // reads user message → collapsed work → final answer.
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

        result.push({ type: 'message', id: msg.id, message: msg });
    }

    result.reverse();
    return result;
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
            if (msg.kind === 'tool-call' && isInteractiveQuestionToolName(msg.tool.name)) return false;
            return true;
        });

        const finalTextIndex = visibleAgentIndexes.find((index) => messages[index].kind === 'agent-text');
        if (finalTextIndex === undefined) continue;

        // Everything older than the turn's final text is foldable EXCEPT a
        // user-selection element — an <options> block carried in an agent-text.
        // (An AskUserQuestion card is already excluded above.) One sitting
        // between tool calls splits the fold so it renders in its true
        // chronological place instead of being pushed to one side of a single
        // merged group. Walk newest-first; each maximal run becomes a group.
        const candidates = visibleAgentIndexes.filter((index) => index > finalTextIndex);

        const turnUserMessageId = indexes
            .map((index) => messages[index])
            .find((message) => message.kind === 'user-text' && !message.pending && message.sendError === undefined)?.id ?? null;

        let run: number[] = [];
        // The newest run completes at the final text; each older run completes
        // at the selection element that split it off (drives the label).
        let boundaryCreatedAt = messages[finalTextIndex].createdAt;

        const flushRun = () => {
            if (run.length === 0) return;
            const runIndexes = run;
            run = [];
            const oldestIdx = Math.max(...runIndexes);
            const runMessages = runIndexes.map((index) => messages[index]);
            const startedAt = Math.min(...runMessages.map((msg) => msg.createdAt));
            // Members render flat when the group expands, so they are stored in
            // the order they will be drawn.
            runMessages.reverse();

            groups.push({
                hiddenIndexes: runIndexes,
                oldestIdx,
                item: {
                    type: 'agent-work-group',
                    id: `work-${messages[oldestIdx].id}`,
                    // Every run split out of one turn carries that turn's own
                    // prompt id, so a turn the user is watching stays expanded
                    // across all of its runs, not just the newest one.
                    turnUserMessageId,
                    messages: runMessages,
                    hasRunning: false,
                    hasPendingPermission: hasPendingPermission(runMessages),
                    startedAt,
                    completedAt: boundaryCreatedAt,
                },
            });
        };

        for (const index of candidates) {
            if (isUserSelectionMessage(messages[index])) {
                flushRun();
                boundaryCreatedAt = messages[index].createdAt;
                continue;
            }
            run.push(index);
        }
        flushRun();
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

// Matches a line that begins (after any leading same-line whitespace) with the
// <options> tag — mirroring the per-line `line.trim().startsWith('<options>')`
// trigger parseMarkdownBlock uses, so inline mentions of "<options>" in prose
// don't match. `[^\S\n]` is "whitespace except newline", matching trim()'s reach.
const OPTIONS_BLOCK_RE = /(?:^|\n)[^\S\n]*<options>/i;

/**
 * Messages that present a user choice and must never be folded into a collapsed
 * work group, or the user cannot see or tap the choice. Interactive-question
 * tool calls are already dropped from `visibleAgentIndexes`; this additionally
 * catches the markdown <options> block, which rides in an agent-text message.
 */
function isUserSelectionMessage(msg: Message): boolean {
    if (msg.kind === 'agent-text') {
        return OPTIONS_BLOCK_RE.test(msg.text);
    }
    if (msg.kind === 'tool-call') {
        return isInteractiveQuestionToolName(msg.tool.name);
    }
    return false;
}

function hasPendingPermission(messages: Message[]): boolean {
    return messages.some((msg) => (
        msg.kind === 'tool-call'
        && msg.tool.permission?.status === 'pending'
    ));
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
