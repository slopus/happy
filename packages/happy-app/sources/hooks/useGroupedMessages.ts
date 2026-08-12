import * as React from 'react';
import { Message } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';
import { t } from '@/text';
import { isGeneratedImageBatchPromptText } from '@/utils/autoFoldPrompt';
import type { AttachmentGalleryPresentation } from '@/utils/attachmentGalleryLayout';
import { getSkillNamesFromTool } from '@/utils/conversationActivity';
import { isGeneratedImageFileInput } from '@/hooks/generatedImagesModel';

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

/**
 * A run of consecutive user-sent image attachments, collapsed so the chat
 * renders them as one horizontal gallery instead of a tall vertical stack.
 * `messages` is chronological (oldest-first) like the other group items.
 */
export type ImageGroupItem = {
    type: 'image-group';
    id: string;
    messages: Message[];
    presentation: AttachmentGalleryPresentation;
    pendingCount: number;
    pendingStartedAt?: number | null;
};

export type ToolDisplayItem = TextItem | ToolGroupItem;
export type DisplayItem = TextItem | ToolGroupItem | AgentWorkGroupItem | ImageGroupItem;
type CollectedAgentWorkGroup = {
    item: AgentWorkGroupItem;
    hiddenIndexes: number[];
    oldestIdx: number;
    turn: number;
};
type ImageAgentPresentationState = {
    featuredAttachmentIds: Set<string>;
    pendingStateByAnchorAttachmentId: Map<string, { count: number; startedAt: number | null }>;
    pendingGroupByWorkOldestIndex: Map<number, ImageGroupItem>;
};

/**
 * The messages array is newest-first for the inverted FlatList.
 *
 * When enabled, intermediate agent work in a turn is collapsed into an
 * AgentWorkGroupItem while the final agent text remains visible. Tool calls
 * that remain outside a work group are collapsed into compact tool groups;
 * adjacent visible tool calls share one group. When disabled, every message
 * passes through.
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
    options: { collapseCurrentTurn?: boolean; groupStandaloneSkills?: boolean } = {},
): DisplayItem[] {
    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    messages = filterSupersededUserMessages(messages);

    if (!enabled) {
        const turnOf = getTurnAssignments(messages);
        const workGroups = collectAgentWorkGroups(messages, turnOf, collapseCurrentTurn, { imageOnly: true });
        const imageAgentPresentation = getImageAgentPresentationState(
            messages,
            turnOf,
            workGroups,
            collapseCurrentTurn,
        );
        const { hiddenWorkIndexes, workGroupByOldestIndex } = indexAgentWorkGroups(workGroups);
        // Tool-call grouping is off, but user image attachments must STILL
        // collapse into a horizontal Kimi-style gallery — the thumbnail UI is
        // independent of the "Group Tool Calls" setting. Without this, images
        // fall back to full-width FileView rows whenever groupToolCalls is
        // false (which is the default), silently undoing the gallery feature.
        const attachmentRuns = collectImageAttachmentGroups(messages, turnOf, hiddenWorkIndexes);
        const result: DisplayItem[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (hiddenWorkIndexes.has(i)) {
                const pendingGroup = imageAgentPresentation.pendingGroupByWorkOldestIndex.get(i);
                if (pendingGroup) {
                    result.push(pendingGroup);
                }
                const workGroup = workGroupByOldestIndex.get(i);
                if (workGroup) {
                    result.push(workGroup);
                }
                continue;
            }
            if (isImageAttachment(msg)) {
                const run = attachmentRuns.get(i);
                // Emit the whole run once, at its oldest member, so visual order
                // (newest-first array → oldest pushed first) stays correct.
                if (run && i === run.oldestIdx) {
                    const chronological = [...run.msgs].reverse();
                    result.push({
                        type: 'image-group',
                        id: `images-${chronological[0].id}`,
                        messages: chronological,
                        presentation: getAttachmentPresentation(chronological, imageAgentPresentation.featuredAttachmentIds),
                        ...getPendingStateForImageGroup(chronological, imageAgentPresentation),
                    });
                }
                continue;
            }
            if (options.groupStandaloneSkills && msg.kind === 'tool-call' && msg.tool.name === 'Skill') {
                result.push({
                    type: 'tool-group',
                    id: `group-${msg.id}`,
                    messages: [msg],
                    hasRunning: msg.tool.state === 'running',
                    hasPendingPermission: hasPendingPermission([msg]),
                });
                continue;
            }
            result.push({ type: 'message', id: msg.id, message: msg });
        }
        return result;
    }

    const turnOf = getTurnAssignments(messages);
    const workGroups = collectAgentWorkGroups(messages, turnOf, collapseCurrentTurn);
    const imageAgentPresentation = getImageAgentPresentationState(
        messages,
        turnOf,
        workGroups,
        collapseCurrentTurn,
    );
    const { hiddenWorkIndexes, workGroupByOldestIndex } = indexAgentWorkGroups(workGroups);

    const visibleForToolGrouping = (msg: Message, index: number): boolean => {
        if (hiddenWorkIndexes.has(index)) return false;
        if (isInvisibleMessage(msg) || isUserAttachment(msg)) return false;
        return msg.kind === 'tool-call';
    };

    const toolRuns = collectToolRuns(messages, visibleForToolGrouping);

    // Consecutive user image attachments collapse into one horizontal gallery.
    const attachmentRuns = collectImageAttachmentGroups(messages, turnOf, hiddenWorkIndexes);

    // Build display items — groups are emitted at their oldest hidden member
    // so the visual order remains user message → collapsed work → final answer.
    const result: DisplayItem[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (isInvisibleMessage(msg)) continue;

        if (hiddenWorkIndexes.has(i)) {
            const pendingGroup = imageAgentPresentation.pendingGroupByWorkOldestIndex.get(i);
            if (pendingGroup) {
                result.push(pendingGroup);
            }
            const workGroup = workGroupByOldestIndex.get(i);
            if (workGroup) {
                result.push(workGroup);
            }
            continue;
        }

        if (isImageAttachment(msg)) {
            const run = attachmentRuns.get(i);
            // Emit the whole run once, at its oldest member, so visual order
            // (newest-first array → oldest pushed first) stays correct.
            if (run && i === run.oldestIdx) {
                const chronological = [...run.msgs].reverse();
                result.push({
                    type: 'image-group',
                    id: `images-${chronological[0].id}`,
                    messages: chronological,
                    presentation: getAttachmentPresentation(chronological, imageAgentPresentation.featuredAttachmentIds),
                    ...getPendingStateForImageGroup(chronological, imageAgentPresentation),
                });
            }
            continue;
        }

        if (msg.kind === 'tool-call') {
            const info = toolRuns.get(i);
            // Questions must remain inline so their answer controls stay immediately reachable.
            const shouldGroupRun = info
                && (info.msgs.length > 1 || msg.tool.name !== 'AskUserQuestion');
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

        // Standalone messages (user text, agent text, events)
        result.push({ type: 'message', id: msg.id, message: msg });
    }

    return result;
}

/**
 * Editing a paused prompt is represented as a new user message so the agent
 * receives the correction without mutating encrypted history. The new
 * message points at the version it replaces; hiding every referenced version
 * makes chained edits render as a single persistent prompt after reload.
 */
export function filterSupersededUserMessages(messages: Message[]): Message[] {
    const supersededIds = new Set<string>();
    for (const message of messages) {
        if (message.kind === 'user-text' && message.meta?.editedFromMessageId) {
            supersededIds.add(message.meta.editedFromMessageId);
        }
    }

    if (supersededIds.size === 0) {
        return messages;
    }

    return messages.filter((message) => (
        message.kind !== 'user-text'
        || (!supersededIds.has(message.id) && (!message.localId || !supersededIds.has(message.localId)))
    ));
}

function getImageAgentPresentationState(
    messages: Message[],
    turnOf: number[],
    workGroups: CollectedAgentWorkGroup[],
    collapseCurrentTurn: boolean,
): ImageAgentPresentationState {
    const featuredAttachmentIds = new Set<string>();
    const pendingStateByAnchorAttachmentId = new Map<string, { count: number; startedAt: number | null }>();
    const pendingGroupByWorkOldestIndex = new Map<number, ImageGroupItem>();
    const workGroupByTurn = new Map<number, CollectedAgentWorkGroup>();

    for (const workGroup of workGroups) {
        workGroupByTurn.set(workGroup.turn, workGroup);
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.kind !== 'user-text' || !isGeneratedImageBatchPromptText(msg.text)) continue;

        const turn = turnOf[i];
        for (let j = i + 1; j < messages.length && isImageAttachment(messages[j]); j++) {
            featuredAttachmentIds.add(messages[j].id);
        }

        const generatedIndexes: number[] = [];
        let hasRunning = turn === 0 && !collapseCurrentTurn;
        for (let j = 0; j < messages.length; j++) {
            const candidate = messages[j];
            if (turnOf[j] !== turn) continue;
            if (isImageAttachment(candidate)) {
                featuredAttachmentIds.add(candidate.id);
                generatedIndexes.push(j);
            }
            if (candidate.kind === 'tool-call' && candidate.tool.state === 'running') {
                hasRunning = true;
            }
        }

        const pendingCount = hasRunning
            ? Math.max(0, getExpectedImageAgentOutputCount(msg.text) - generatedIndexes.length)
            : 0;
        if (pendingCount === 0) continue;

        const workGroup = workGroupByTurn.get(turn);
        const pendingStartedAt = workGroup?.item.startedAt ?? null;

        if (generatedIndexes.length > 0) {
            pendingStateByAnchorAttachmentId.set(messages[generatedIndexes[0]].id, {
                count: pendingCount,
                startedAt: pendingStartedAt,
            });
            continue;
        }

        if (workGroup) {
            pendingGroupByWorkOldestIndex.set(workGroup.oldestIdx, {
                type: 'image-group',
                id: `images-pending-${msg.id}`,
                messages: [],
                presentation: 'generated-grid',
                pendingCount,
                pendingStartedAt,
            });
        }
    }

    return { featuredAttachmentIds, pendingStateByAnchorAttachmentId, pendingGroupByWorkOldestIndex };
}

function getAttachmentPresentation(messages: Message[], featuredAttachmentIds: Set<string>): AttachmentGalleryPresentation {
    if (messages.some(isGeneratedImageAttachment)) return 'generated-grid';
    return messages.some((message) => featuredAttachmentIds.has(message.id)) ? 'featured' : 'compact';
}

function isGeneratedImageAttachment(message: Message): boolean {
    if (!isImageAttachment(message) || message.kind !== 'tool-call') return false;
    return isGeneratedImageFileInput(message.tool.input);
}

function getPendingStateForImageGroup(
    messages: Message[],
    state: ImageAgentPresentationState,
): { pendingCount: number; pendingStartedAt?: number | null } {
    for (const message of messages) {
        const pendingState = state.pendingStateByAnchorAttachmentId.get(message.id);
        if (pendingState !== undefined) {
            return {
                pendingCount: pendingState.count,
                pendingStartedAt: pendingState.startedAt,
            };
        }
    }
    return { pendingCount: 0 };
}

function getExpectedImageAgentOutputCount(text: string): number {
    const explicitTotalMatch = text.match(/预计输出总数\s*(\d+)\s*张/);
    if (explicitTotalMatch) {
        return Math.max(1, Number.parseInt(explicitTotalMatch[1], 10) || 1);
    }

    const variantsMatch = text.match(/各生成\s*(\d+)\s*张变体/);
    const variants = variantsMatch ? Math.max(1, Number.parseInt(variantsMatch[1], 10) || 1) : 1;
    const styleSectionIndex = text.search(/已选择的\s+GPT Image(?: 2| Gallery)?\s*风格/);
    if (styleSectionIndex < 0) return variants;

    const styleCount = text
        .slice(styleSectionIndex)
        .split('\n')
        .filter((line) => /^\s*\d+\.\s+/.test(line))
        .length;
    return Math.max(1, styleCount * variants);
}

function indexAgentWorkGroups(workGroups: CollectedAgentWorkGroup[]): {
    hiddenWorkIndexes: Set<number>;
    workGroupByOldestIndex: Map<number, AgentWorkGroupItem>;
} {
    const hiddenWorkIndexes = new Set<number>();
    const workGroupByOldestIndex = new Map<number, AgentWorkGroupItem>();

    for (const group of workGroups) {
        workGroupByOldestIndex.set(group.oldestIdx, group.item);
        for (const index of group.hiddenIndexes) {
            hiddenWorkIndexes.add(index);
        }
    }

    return { hiddenWorkIndexes, workGroupByOldestIndex };
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

function collectImageAttachmentGroups(
    messages: Message[],
    turnOf: number[],
    hiddenWorkIndexes: Set<number>,
): Map<number, { msgs: Message[]; oldestIdx: number }> {
    const groups = collectToolRuns(
        messages,
        (message, index) => (
            !hiddenWorkIndexes.has(index)
            && isImageAttachment(message)
            && getImageAttachmentBatchId(message) === null
        ),
    );
    const batchGroups = new Map<string, { indexes: number[]; msgs: Message[] }>();

    for (let index = 0; index < messages.length; index++) {
        if (hiddenWorkIndexes.has(index) || !isImageAttachment(messages[index])) continue;
        const batchId = getImageAttachmentBatchId(messages[index]);
        if (!batchId) continue;
        const key = `${turnOf[index]}:${batchId}`;
        const group = batchGroups.get(key) ?? { indexes: [], msgs: [] };
        group.indexes.push(index);
        group.msgs.push(messages[index]);
        batchGroups.set(key, group);
    }

    for (const group of batchGroups.values()) {
        const oldestIdx = group.indexes[group.indexes.length - 1];
        const indexedGroup = { msgs: group.msgs, oldestIdx };
        for (const index of group.indexes) {
            groups.set(index, indexedGroup);
        }
    }

    return groups;
}

function getImageAttachmentBatchId(message: Message): string | null {
    if (!isImageAttachment(message) || message.kind !== 'tool-call') return null;
    const batchId = message.tool.input?.batchId;
    return typeof batchId === 'string' && batchId.trim().length > 0
        ? batchId.trim()
        : null;
}

function collectAgentWorkGroups(
    messages: Message[],
    turnOf: number[],
    collapseCurrentTurn: boolean,
    options: { imageOnly?: boolean } = {},
): CollectedAgentWorkGroup[] {
    const segments = new Map<number, number[]>();
    for (let i = 0; i < messages.length; i++) {
        const turn = turnOf[i];
        if (!segments.has(turn)) {
            segments.set(turn, []);
        }
        segments.get(turn)!.push(i);
    }

    const groups: CollectedAgentWorkGroup[] = [];

    for (const [turn, indexes] of segments) {
        const visibleAgentIndexes = indexes.filter((index) => {
            const msg = messages[index];
            if (msg.kind === 'user-text') return false;
            if (isInvisibleMessage(msg) || isUserAttachment(msg)) return false;
            return true;
        });
        if (visibleAgentIndexes.length === 0) continue;

        const isImageAgentTurn = indexes.some((index) => {
            const msg = messages[index];
            return msg.kind === 'user-text' && isGeneratedImageBatchPromptText(msg.text);
        });
        const isCurrentTurn = turn === 0;

        if (isImageAgentTurn) {
            const hasGeneratedAttachment = indexes.some((index) => isImageAttachment(messages[index]));
            const isActiveTurn = isCurrentTurn && !collapseCurrentTurn;
            if (hasGeneratedAttachment || isActiveTurn) {
                const hiddenIndexes = visibleAgentIndexes;
                const oldestIdx = Math.max(...hiddenIndexes);
                const hiddenMessages = hiddenIndexes.map((index) => messages[index]);
                const startedAt = Math.min(...hiddenMessages.map((msg) => msg.createdAt));
                const hasRunning = isActiveTurn
                    || hiddenMessages.some((msg) => msg.kind === 'tool-call' && msg.tool.state === 'running');
                const completedAt = hasRunning
                    ? null
                    : Math.max(...hiddenMessages.map((msg) => msg.createdAt));

                groups.push({
                    turn,
                    hiddenIndexes,
                    oldestIdx,
                    item: {
                        type: 'agent-work-group',
                        id: `work-${messages[oldestIdx].id}`,
                        messages: hiddenMessages,
                        hasRunning,
                        hasPendingPermission: hasPendingPermission(hiddenMessages),
                        startedAt,
                        completedAt,
                    },
                });
                continue;
            }
        }

        if (options.imageOnly) {
            continue;
        }

        if (isCurrentTurn && !collapseCurrentTurn) {
            continue;
        }

        const finalTextIndex = visibleAgentIndexes.find((index) => messages[index].kind === 'agent-text');
        if (finalTextIndex === undefined) continue;

        const hiddenIndexes = visibleAgentIndexes.filter((index) => index > finalTextIndex);
        if (hiddenIndexes.length === 0) continue;

        const oldestIdx = Math.max(...hiddenIndexes);
        const hiddenMessages = hiddenIndexes.map((index) => messages[index]);
        const startedAt = Math.min(...hiddenMessages.map((msg) => msg.createdAt));
        const completedAt = messages[finalTextIndex].createdAt;
        const hasRunning = hiddenMessages.some((msg) => msg.kind === 'tool-call' && msg.tool.state === 'running');

        groups.push({
            turn,
            hiddenIndexes,
            oldestIdx,
            item: {
                type: 'agent-work-group',
                id: `work-${messages[oldestIdx].id}`,
                messages: hiddenMessages,
                hasRunning,
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

function isImageAttachment(msg: Message): boolean {
    if (msg.kind !== 'tool-call' || msg.tool.name !== 'file') return false;
    const kind = msg.tool.input?.kind;
    return kind !== 'audio'
        && kind !== 'video'
        && kind !== 'file'
        && !msg.tool.input?.motionPhoto;
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
    Skill: 'skill',
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
    if (counts.skill) {
        const names = messages
            .flatMap((message) => message.kind === 'tool-call' && message.tool.name === 'Skill'
                ? getSkillNamesFromTool(message.tool)
                : [])
            .filter((name, index, all) => all.indexOf(name) === index);
        parts.push(names.length > 0
            ? t('toolGroup.usedSkills', { names: names.join(', ') })
            : t('toolGroup.usedTools', { count: counts.skill }));
    }
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
