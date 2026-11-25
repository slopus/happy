import { isGenericToolFailure, selectToolFailure, summarizeToolFailureOutput } from '@slopus/happy-wire';
import { Message, ToolCall, ToolCallMessage } from '@/sync/typesMessage';
import { getEffectiveToolName, getSkillDocumentName } from './toolIdentity';
import { getSkillCommandNames } from './skillCommandReads';
import { getToolSummaryDetail } from './toolDisplay';

export type ConversationActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type SkillConversationActivity = {
    kind: 'skill';
    id: string;
    name: string;
    source?: 'document-read' | 'command-read';
    isBatch?: boolean;
    status: ConversationActivityStatus;
    failure: ToolCall['failure'] | null;
    updatedAt: number;
    depth: number;
    order: number;
    invocationMessageIds: string[];
};

export type SubagentConversationActivity = {
    kind: 'subagent';
    id: string;
    title: string | null;
    status: ConversationActivityStatus;
    updatedAt: number;
    depth: number;
    order: number;
    startedAt?: number | null;
    completedAt?: number | null;
    currentAction?: string | null;
    model?: string | null;
    effort?: string | null;
    provider?: string | null;
    failureSummary?: string | null;
};

export type ConversationActivities = {
    skills: SkillConversationActivity[];
    subagents: SubagentConversationActivity[];
};

export type SubagentTranscript = {
    agent: ToolCallMessage;
    messages: Message[];
};

export function findSubagentTranscript(messages: Message[], subagentId: string): SubagentTranscript | null {
    const chronologicalMessages = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    for (const message of chronologicalMessages) {
        if (message.kind !== 'tool-call') {
            continue;
        }

        const isAgentTool = message.tool.name === 'Agent' || message.tool.name === 'Task';
        if (isAgentTool && message.tool.input?.sessionSubagent === subagentId) {
            return {
                agent: message,
                messages: message.children
                    .filter((child) => {
                        if (child.kind === 'agent-text' && child.isThinking) return false;
                        return child.kind !== 'agent-event'
                            || child.event.type !== 'subagent-status'
                            || child.event.subagent !== subagentId;
                    })
                    .sort((a, b) => a.createdAt - b.createdAt),
            };
        }

        const nestedTranscript = findSubagentTranscript(message.children, subagentId);
        if (nestedTranscript) {
            return nestedTranscript;
        }
    }

    return null;
}

function toolStatus(tool: ToolCall): ConversationActivityStatus {
    if (tool.permission?.status === 'canceled') {
        return 'cancelled';
    }
    if (tool.state === 'error') {
        return 'failed';
    }
    return tool.state;
}

function getToolFailure(message: ToolCallMessage): ToolCall['failure'] | null {
    const tool = message.tool;
    if (tool.state !== 'error') return null;
    if (tool.failure?.summary && !isGenericToolFailure(tool.failure.summary) && summarizeToolFailureOutput(tool.failure.summary)) {
        return tool.failure;
    }

    // Older CLI versions stored the first line of stdout as the summary and
    // truncated its detail. Command-output children can still contain the error.
    const commandOutput = message.children
        .filter((child) => child.kind === 'agent-text' && child.isThinking)
        .map((child) => child.kind === 'agent-text' ? child.text : '')
        .join('');
    const failure = selectToolFailure([tool.result, commandOutput, tool.failure?.detail, tool.failure?.summary], tool.failure?.summary ?? '');
    return failure.summary ? { ...tool.failure, ...failure } : null;
}

export function getSkillNamesFromTool(tool: Pick<ToolCall, 'name' | 'input'>): string[] {
    if (tool.name === 'ego-browser' || tool.name === 'ego-ops') return [tool.name];
    const documentName = getSkillDocumentName(tool);
    if (documentName) return [documentName];
    if (getEffectiveToolName(tool) !== 'Skill') {
        return [];
    }

    const names = new Set<string>();
    const candidates = [tool.input?.skillNames, tool.input?.skills];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
            continue;
        }
        for (const name of candidate) {
            if (typeof name === 'string' && name.trim().length > 0) {
                names.add(name.trim());
            }
        }
    }

    for (const candidate of [tool.input?.skill, tool.input?.skillName, tool.input?.name]) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            names.add(candidate.trim());
        }
    }

    return [...names];
}

function getSubagentTitle(tool: ToolCall): string | null {
    for (const candidate of [
        tool.input?.description,
        tool.input?.title,
        tool.input?.agentPath,
        tool.input?.agent_path,
        tool.input?.subagent_type,
        tool.input?.prompt,
    ]) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

function explicitText(...values: unknown[]): string | null {
    return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null;
}

function timestamp(...values: unknown[]): number | null {
    return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0) ?? null;
}

function* ownSubagentTools(messages: Message[]): Generator<ToolCallMessage> {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        // A delegated agent owns its entire subtree. Its commands are not
        // actions or failures belonging to this agent.
        if (message.tool.name === 'Agent' || message.tool.name === 'Task') continue;
        yield message;
        yield* ownSubagentTools(message.children);
    }
}

function getSubagentAction(messages: Message[], running: boolean): ToolCallMessage | null {
    let latest: ToolCallMessage | null = null;
    let latestAt = -1;
    let active: ToolCallMessage | null = null;
    let activeAt = -1;
    for (const message of ownSubagentTools(messages)) {
        const at = timestamp(message.tool.completedAt, message.tool.startedAt, message.createdAt) ?? 0;
        if (at >= latestAt) { latest = message; latestAt = at; }
        if (toolStatus(message.tool) === 'running' && at >= activeAt) { active = message; activeAt = at; }
    }
    return running ? active ?? latest : latest;
}

function getSubagentFailure(agentCalls: ToolCallMessage[], messages: Message[], runStartedAt?: number): string | null {
    // A successful resume/sendInput supersedes errors from older calls to this
    // agent. Cleanup or log reads may succeed after its actual failing command.
    // Select the latest own failure independently from the displayed action.
    const latestCall = [...agentCalls].sort((a, b) => (
        (timestamp(a.tool.startedAt, a.createdAt) ?? 0) - (timestamp(b.tool.startedAt, b.createdAt) ?? 0)
    )).at(-1);
    let failedAction: ToolCallMessage | null = null;
    let failedActionAt = -1;
    for (const message of ownSubagentTools(messages)) {
        if (message.tool.state !== 'error') continue;
        const at = timestamp(message.tool.completedAt, message.tool.startedAt, message.createdAt) ?? 0;
        if (at >= failedActionAt) { failedAction = message; failedActionAt = at; }
    }
    let summary: string | null = null;
    let latestFailureAt = -1;
    for (const candidate of [latestCall, failedAction]) {
        if (!candidate) continue;
        const failure = getToolFailure(candidate);
        const at = timestamp(candidate.tool.completedAt, candidate.tool.startedAt, candidate.createdAt) ?? 0;
        if (failure?.summary && at >= (runStartedAt ?? 0) && at >= latestFailureAt) {
            summary = failure.summary;
            latestFailureAt = at;
        }
    }
    return summary;
}

export function collectConversationActivities(
    messages: Message[],
    options: { rootSubagentId?: string } = {},
): ConversationActivities {
    const skillActivities = new Map<string, SkillConversationActivity>();
    const subagentDefaults = new Map<string, SubagentConversationActivity>();
    const subagentTools = new Map<string, ToolCallMessage[]>();
    const subagentEvents: SubagentConversationActivity[] = [];
    const subagentRunStarts = new Map<string, number>();
    let sequence = 0;

    const visit = (items: Message[], depth: number, ownerPath: string[]): void => {
        const chronologicalItems = [...items].sort((a, b) => a.createdAt - b.createdAt);
        for (const message of chronologicalItems) {
            sequence += 1;
            if (message.kind === 'agent-event' && message.event.type === 'subagent-status') {
                const ownerDepth = ownerPath.lastIndexOf(message.event.subagent);
                subagentEvents.push({
                    kind: 'subagent',
                    id: message.event.subagent,
                    title: message.event.title ?? null,
                    status: message.event.status,
                    updatedAt: message.createdAt,
                    depth: ownerDepth >= 0 ? ownerDepth : Math.max(0, depth - 1),
                    order: sequence,
                });
                continue;
            }

            if (message.kind !== 'tool-call') {
                continue;
            }

            const nativeNames = getSkillNamesFromTool(message.tool);
            const commandNames = nativeNames.length === 0 ? getSkillCommandNames(message.tool) : [];
            const isCommandRead = commandNames.length > 0;
            const skillNames = isCommandRead ? commandNames : nativeNames;
            const isDocumentRead = getSkillDocumentName(message.tool) !== null;
            // A shell command supplies one status for the entire batch. Do not
            // invent per-file outcomes (later reads may be skipped by &&).
            if (skillNames.length > 0 && !((isDocumentRead || isCommandRead) && message.tool.permission?.status === 'pending')) {
                const isBatch = skillNames.length > 1;
                const name = skillNames.join(', ');
                const key = JSON.stringify([ownerPath, isCommandRead ? 'command-read' : isDocumentRead ? 'document-read' : isBatch ? 'batch' : 'skill',
                    isBatch ? message.tool.callId ?? message.id : name]);
                const next: SkillConversationActivity = {
                    kind: 'skill',
                    id: key,
                    name,
                    ...(isCommandRead ? { source: 'command-read' as const }
                        : isDocumentRead ? { source: 'document-read' as const } : {}),
                    ...(isBatch ? { isBatch: true } : {}),
                    status: toolStatus(message.tool),
                    failure: isCommandRead ? null : getToolFailure(message),
                    updatedAt: message.tool.completedAt ?? message.createdAt,
                    depth,
                    order: sequence,
                    invocationMessageIds: [message.id],
                };
                const existing = skillActivities.get(key);
                if (!existing || next.status === 'running' || next.updatedAt >= existing.updatedAt) {
                    skillActivities.set(key, existing ? {
                        ...next,
                        order: existing.order,
                        invocationMessageIds: [...existing.invocationMessageIds, message.id],
                    } : next);
                } else if (existing) {
                    existing.invocationMessageIds.push(message.id);
                }
            }

            const sessionSubagent = message.tool.input?.sessionSubagent;
            if ((message.tool.name === 'Task' || message.tool.name === 'Agent')
                && typeof sessionSubagent === 'string'
                && sessionSubagent.length > 0) {
                const previous = subagentDefaults.get(sessionSubagent);
                const startedAt = timestamp(message.tool.startedAt, message.tool.createdAt, message.createdAt);
                subagentDefaults.set(sessionSubagent, {
                    kind: 'subagent',
                    id: sessionSubagent,
                    title: getSubagentTitle(message.tool),
                    status: toolStatus(message.tool),
                    updatedAt: message.tool.completedAt ?? message.createdAt,
                    depth,
                    order: sequence,
                    startedAt: previous?.startedAt != null && startedAt != null ? Math.min(previous.startedAt, startedAt) : startedAt ?? previous?.startedAt ?? null,
                    completedAt: toolStatus(message.tool) === 'running' ? null : timestamp(message.tool.completedAt),
                    // Tool metadata can describe the parent's selected mode;
                    // only explicit arguments to this agent identify its mode.
                    model: explicitText(message.tool.input?.model) ?? previous?.model ?? null,
                    effort: explicitText(message.tool.input?.reasoningEffort, message.tool.input?.reasoning_effort, message.tool.input?.effort) ?? previous?.effort ?? null,
                    provider: explicitText(message.tool.input?.provider, message.tool.input?.flavor) ?? previous?.provider ?? null,
                });
                subagentTools.set(sessionSubagent, [...(subagentTools.get(sessionSubagent) ?? []), message]);
                visit(message.children, depth + 1, [...ownerPath, sessionSubagent]);
                continue;
            }

            visit(message.children, depth, ownerPath);
        }
    };

    const rootSubagentId = options.rootSubagentId;
    visit(messages, rootSubagentId ? 1 : 0, rootSubagentId ? [rootSubagentId] : []);

    const subagents = new Map(subagentDefaults);
    subagentEvents
        .sort((a, b) => a.updatedAt - b.updatedAt || a.order - b.order)
        .forEach((event) => {
            if (event.status === 'running') subagentRunStarts.set(event.id, event.updatedAt);
            const existing = subagents.get(event.id);
            subagents.set(event.id, {
                ...existing,
                kind: 'subagent',
                id: event.id,
                title: event.title ?? existing?.title ?? null,
                status: event.status,
                updatedAt: event.updatedAt,
                depth: existing?.depth ?? event.depth,
                order: existing?.order ?? event.order,
                // A spawn tool may return long before its agent finishes.
                // Lifecycle events are authoritative and freeze terminal time.
                startedAt: existing?.startedAt ?? (event.status === 'running' ? event.updatedAt : null),
                completedAt: event.status === 'running' ? null : event.updatedAt,
            });
        });

    return {
        skills: [...skillActivities.values()].sort((a, b) => a.order - b.order),
        subagents: [...subagents.values()].sort((a, b) => a.order - b.order).map((activity) => {
            const agentCalls = subagentTools.get(activity.id) ?? [];
            const ownMessages = agentCalls.flatMap((agent) => agent.children);
            const action = getSubagentAction(ownMessages, activity.status === 'running');
            return {
                ...activity,
                currentAction: action ? getToolSummaryDetail(action.tool) ?? getEffectiveToolName(action.tool) : null,
                failureSummary: activity.status === 'failed'
                    ? getSubagentFailure(agentCalls, ownMessages, subagentRunStarts.get(activity.id))
                    : null,
            };
        }),
    };
}
