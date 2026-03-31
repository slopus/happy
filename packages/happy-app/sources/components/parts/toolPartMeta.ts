import { type v3 } from '@slopus/happy-sync';

export interface ToolPermissionState {
    id: string;
    status: 'pending' | 'approved' | 'denied';
    reason?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied';
}

function prettifyToolName(toolName: string): string {
    if (toolName.startsWith('mcp__')) {
        return toolName
            .split('__')
            .filter(Boolean)
            .map((segment) => prettifyToolName(segment))
            .join(' / ');
    }

    return toolName
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim();
}

function readString(input: Record<string, unknown>, key: string): string | null {
    const value = input[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function shortenFilePath(path: string): string {
    const segments = path.split('/').filter(Boolean);
    if (segments.length <= 2) {
        return path;
    }
    return segments.slice(-2).join('/');
}

export function getToolPartTitle(part: v3.ToolPart): string {
    const stateTitle =
        part.state.status === 'running'
        || part.state.status === 'blocked'
        || part.state.status === 'completed'
            ? part.state.title
            : undefined;

    return (
        stateTitle?.trim()
        ?? readString(part.state.input, 'title')
        ?? prettifyToolName(part.tool)
    );
}

export function getToolPartSubtitle(part: v3.ToolPart): string | null {
    const title = getToolPartTitle(part);
    const input = part.state.input;

    const filePath = readString(input, 'file_path') ?? readString(input, 'path') ?? readString(input, 'notebook_path');

    const directCandidate =
        readString(input, 'command')
        ?? (filePath ? shortenFilePath(filePath) : null)
        ?? readString(input, 'url')
        ?? readString(input, 'query')
        ?? readString(input, 'pattern')
        ?? readString(input, 'prompt')
        ?? readString(input, 'notebook_path')
        ?? readString(input, 'description')
        ?? readString(input, 'task_id');

    if (directCandidate && directCandidate !== title) {
        return directCandidate;
    }

    const locations = input.locations;
    if (Array.isArray(locations)) {
        const firstLocation = locations[0];
        if (firstLocation && typeof firstLocation === 'object' && firstLocation !== null) {
            const path = (firstLocation as { path?: unknown }).path;
            if (typeof path === 'string' && path !== title) {
                return path;
            }
        }
    }

    const questions = input.questions;
    if (Array.isArray(questions)) {
        const firstQuestion = questions[0];
        if (firstQuestion && typeof firstQuestion === 'object' && firstQuestion !== null) {
            const question = (firstQuestion as { question?: unknown }).question;
            if (typeof question === 'string' && question !== title) {
                return question;
            }
        }
    }

    return null;
}

export function getToolPartStatusLabel(part: v3.ToolPart): string {
    switch (part.state.status) {
        case 'pending':
            return 'Pending';
        case 'running':
            return 'Running';
        case 'blocked':
            return part.state.block.type === 'question'
                ? 'Awaiting answer'
                : 'Awaiting approval';
        case 'completed':
            return 'Completed';
        case 'error':
            return 'Error';
    }
}

export function getPendingPermissionBlock(part: v3.ToolPart): v3.PermissionBlock | null {
    return part.state.status === 'blocked' && part.state.block.type === 'permission'
        ? part.state.block
        : null;
}

export function getResolvedPermissionBlock(part: v3.ToolPart): v3.ResolvedPermissionBlock | null {
    if (part.state.status !== 'completed' && part.state.status !== 'error') {
        return null;
    }

    return part.state.block?.type === 'permission'
        ? part.state.block
        : null;
}

export function getPendingQuestionBlock(part: v3.ToolPart): v3.QuestionBlock | null {
    return part.state.status === 'blocked' && part.state.block.type === 'question'
        ? part.state.block
        : null;
}

export function getResolvedQuestionBlock(part: v3.ToolPart): v3.ResolvedQuestionBlock | null {
    if (part.state.status !== 'completed' && part.state.status !== 'error') {
        return null;
    }

    return part.state.block?.type === 'question'
        ? part.state.block
        : null;
}

export function getToolPermissionState(part: v3.ToolPart): ToolPermissionState | null {
    const pending = getPendingPermissionBlock(part);
    if (pending) {
        return {
            id: pending.id,
            status: 'pending',
            allowedTools: pending.always,
        };
    }

    const resolved = getResolvedPermissionBlock(part);
    if (!resolved) {
        return null;
    }

    if (resolved.decision === 'reject') {
        return {
            id: resolved.id,
            status: 'denied',
            decision: 'denied',
            reason: part.state.status === 'error' ? part.state.error : undefined,
        };
    }

    return {
        id: resolved.id,
        status: 'approved',
        allowedTools: resolved.decision === 'always' ? resolved.always : undefined,
        decision: resolved.decision === 'always' ? 'approved_for_session' : 'approved',
    };
}

export function getToolResultText(part: v3.ToolPart): string | null {
    switch (part.state.status) {
        case 'completed':
            return part.state.output;
        case 'error':
            return part.state.error;
        default:
            return null;
    }
}

export function getToolPreviewText(part: v3.ToolPart): string | null {
    if (part.state.status === 'blocked') {
        return part.state.block.type === 'question'
            ? 'User input required to continue.'
            : 'Approval required to continue.';
    }

    if (part.state.status === 'pending') {
        return 'Queued for execution.';
    }

    const result = getToolResultText(part);
    if (!result) {
        return null;
    }

    const trimmed = result.trim();
    if (!trimmed) {
        return null;
    }

    const [firstLine] = trimmed.split('\n');
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}
