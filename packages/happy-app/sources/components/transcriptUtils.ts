import type {
    PermissionRequest,
    QuestionRequest,
    SessionMessage,
    SessionToolResult,
    SessionToolUse,
    SessionUserContent,
} from '@slopus/happy-sync';

export type ToolUseState = 'running' | 'completed' | 'error' | 'awaiting_approval' | 'awaiting_answer';

export function getUserContentMarkdown(content: SessionUserContent[]): string {
    return content.flatMap((item) => {
        if ('Text' in item) {
            return item.Text ? [item.Text] : [];
        }

        if ('Mention' in item) {
            const label = item.Mention.content || item.Mention.uri;
            return label ? [`[${label}](${item.Mention.uri})`] : [];
        }

        return [];
    }).join('\n\n');
}

export function getUserContentImages(content: SessionUserContent[]): Array<{ source: string; size?: { width: number; height: number } | null }> {
    return content.flatMap((item) => ('Image' in item ? [item.Image] : []));
}

export function getToolUseState(
    toolUse: SessionToolUse,
    result?: SessionToolResult,
    permission?: PermissionRequest,
    question?: QuestionRequest,
): ToolUseState {
    if (permission && !permission.resolved) {
        return 'awaiting_approval';
    }

    if (question && !question.resolved) {
        return 'awaiting_answer';
    }

    if (!result) {
        return 'running';
    }

    return result.is_error ? 'error' : 'completed';
}

export function findPermissionForTool(
    toolUseId: string,
    permissions: PermissionRequest[],
): PermissionRequest | undefined {
    return permissions.find((p) => p.callId === toolUseId);
}

export function findQuestionForTool(
    toolUseId: string,
    questions: QuestionRequest[],
): QuestionRequest | undefined {
    return questions.find((q) => q.callId === toolUseId);
}

export function formatToolValue(value: unknown, fallbackRaw?: string): string | null {
    if (value == null) {
        return fallbackRaw ?? null;
    }

    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return fallbackRaw ?? null;
    }
}

export function getToolResultText(result?: SessionToolResult): string | null {
    if (!result) {
        return null;
    }

    if ('Text' in result.content) {
        return result.content.Text;
    }

    return null;
}

export function isAgentMessage(message: SessionMessage): message is Extract<SessionMessage, { Agent: unknown }> {
    return typeof message === 'object' && message !== null && 'Agent' in message;
}

export function isUserMessage(message: SessionMessage): message is Extract<SessionMessage, { User: unknown }> {
    return typeof message === 'object' && message !== null && 'User' in message;
}
