import type { AgentGoalStatus } from '@/api/types';

type AgentGoalCapabilities = NonNullable<Extract<AgentGoalStatus, { status: 'active' }>['capabilities']>;

export type ClaudeGoalStatusAttachment = {
    type: 'goal_status';
    met: boolean;
    condition: string;
    sentinel?: boolean;
    reason?: string;
    iterations?: number;
    durationMs?: number;
    tokens?: number;
};

export type ClaudeGoalStatusTranscriptEvent = {
    type: 'goal_status';
    uuid: string;
    sourceSessionId: string;
    sourceRevision: string;
    timestamp?: string;
    attachment: ClaudeGoalStatusAttachment;
};

export type ClaudeGoalCommand =
    | { type: 'set'; objective: string }
    | { type: 'clear' };

export type ClaudeGoalActionCapabilitiesOptions = {
    goalCommandSupported: boolean;
    observedGoalStatus: boolean;
    confirmedActions?: Partial<Record<keyof typeof CLAUDE_GOAL_ACTION_CONFIRMATIONS, boolean>>;
};

export const CLAUDE_GOAL_ACTION_CONFIRMATIONS = {
    clear: true,
    edit: true,
} as const;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type ClaudeGoalStatusBase = {
    source: 'claude';
    observedAt: number;
    sourceSessionId: string;
    sourceRevision: string;
};

function baseStatus(event: ClaudeGoalStatusTranscriptEvent): ClaudeGoalStatusBase {
    return {
        source: 'claude',
        observedAt: Date.now(),
        sourceSessionId: event.sourceSessionId,
        sourceRevision: event.sourceRevision,
    };
}

export function parseClaudeGoalStatusTranscriptEvent(value: unknown): ClaudeGoalStatusTranscriptEvent | null {
    const message = record(value);
    if (!message || message.type !== 'attachment') {
        return null;
    }

    const attachment = record(message.attachment);
    if (!attachment || attachment.type !== 'goal_status' || typeof attachment.met !== 'boolean') {
        return null;
    }

    const uuid = nonEmptyString(message.uuid);
    const sourceSessionId = nonEmptyString(message.sessionId);
    const condition = nonEmptyString(attachment.condition);
    if (!uuid || !sourceSessionId || !condition) {
        return null;
    }

    return {
        type: 'goal_status',
        uuid,
        sourceSessionId,
        sourceRevision: uuid,
        timestamp: optionalString(message.timestamp),
        attachment: {
            type: 'goal_status',
            met: attachment.met,
            condition,
            sentinel: optionalBoolean(attachment.sentinel),
            reason: optionalString(attachment.reason),
            iterations: optionalNumber(attachment.iterations),
            durationMs: optionalNumber(attachment.durationMs),
            tokens: optionalNumber(attachment.tokens),
        },
    };
}

export function mapClaudeGoalStatusEventToAgentGoalStatus(
    event: ClaudeGoalStatusTranscriptEvent,
    currentClaudeSessionId?: string | null,
    opts?: { capabilities?: AgentGoalCapabilities },
): AgentGoalStatus | null {
    if (currentClaudeSessionId && event.sourceSessionId !== currentClaudeSessionId) {
        return null;
    }

    if (event.attachment.met) {
        return {
            ...baseStatus(event),
            status: 'inactive',
            reason: event.attachment.sentinel ? 'cleared' : 'completed',
        };
    }

    return {
        ...baseStatus(event),
        status: 'active',
        text: event.attachment.condition,
        ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
    };
}

export function reduceClaudeGoalStatusEvents(
    events: Iterable<ClaudeGoalStatusTranscriptEvent>,
    currentClaudeSessionId: string,
    opts?: { capabilities?: AgentGoalCapabilities },
): AgentGoalStatus | null {
    let latest: AgentGoalStatus | null = null;

    for (const event of events) {
        const status = mapClaudeGoalStatusEventToAgentGoalStatus(event, currentClaudeSessionId, opts);
        if (status) {
            latest = status;
        }
    }

    return latest;
}

export function claudeGoalActionCapabilities(opts: ClaudeGoalActionCapabilitiesOptions): AgentGoalCapabilities | undefined {
    if (!opts.goalCommandSupported || !opts.observedGoalStatus) {
        return undefined;
    }

    const capabilities: AgentGoalCapabilities = {};
    if (opts.confirmedActions?.clear) {
        capabilities.clear = true;
    }
    if (opts.confirmedActions?.edit) {
        capabilities.edit = true;
    }

    return capabilities.clear || capabilities.edit ? capabilities : undefined;
}

export function parseClaudeGoalActionParams(params: Record<string, unknown>): ClaudeGoalCommand | null {
    if (params.action === 'clear') {
        return { type: 'clear' };
    }

    if (params.action === 'edit') {
        const objective = nonEmptyString(params.objective);
        return objective ? { type: 'set', objective } : null;
    }

    return null;
}
