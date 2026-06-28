import type { Thread, ThreadItem, ThreadTurn } from './codexAppServerTypes';

export type CodexRewindPoint = {
    itemId: string;
    text: string;
    timestamp: number;
};

export type CodexForkResult = {
    type: 'success';
    newCodexThreadId: string;
};

type CodexForkClient = {
    forkThread: (opts: {
        threadId: string;
        cwd?: string;
        model?: string;
        approvalPolicy?: any;
        sandbox?: any;
        mcpServers?: Record<string, unknown>;
    }) => Promise<{ threadId: string; thread: Thread }>;
    rollbackThread: (opts: { threadId: string; numTurns: number }) => Promise<{ thread: Thread }>;
    injectItems: (opts: { threadId: string; items: unknown[] }) => Promise<unknown>;
};

export class CodexForkRewindPointNotFoundError extends Error {
    constructor(public readonly itemId: string, public readonly threadId: string) {
        super(`Codex rewind point ${itemId} not found in thread ${threadId}`);
        this.name = 'CodexForkRewindPointNotFoundError';
    }
}

function textFromUserItem(item: ThreadItem): string | null {
    if (item.type !== 'userMessage') {
        return null;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
        return null;
    }
    const textParts = content
        .filter((part): part is { type: 'text'; text: string } => (
            Boolean(part)
            && typeof part === 'object'
            && (part as { type?: unknown }).type === 'text'
            && typeof (part as { text?: unknown }).text === 'string'
        ))
        .map((part) => part.text)
        .join('\n')
        .trim();
    return textParts.length > 0 ? textParts : null;
}

function timestampFromTurn(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

export function listCodexRewindPoints(thread: Pick<Thread, 'turns'>): CodexRewindPoint[] {
    const points: CodexRewindPoint[] = [];
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            const text = textFromUserItem(item);
            if (!text) {
                continue;
            }
            points.push({
                itemId: item.id,
                text,
                timestamp: timestampFromTurn(turn),
            });
        }
    }
    return points;
}

function findCutTurn(thread: Thread, itemId: string): { index: number; text: string } | null {
    const turns = thread.turns ?? [];
    for (let index = 0; index < turns.length; index++) {
        const turn = turns[index];
        const item = (turn.items ?? []).find((candidate) => candidate.id === itemId);
        if (!item) {
            continue;
        }
        const text = textFromUserItem(item);
        if (text) {
            return { index, text };
        }
    }
    return null;
}

export async function forkCodexThread(
    client: CodexForkClient,
    opts: {
        threadId: string;
        cwd?: string;
        cutAfterItemId?: string;
        model?: string;
        approvalPolicy?: any;
        sandbox?: any;
        mcpServers?: Record<string, unknown>;
    },
): Promise<CodexForkResult> {
    const forked = await client.forkThread({
        threadId: opts.threadId,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    });

    if (opts.cutAfterItemId) {
        const cutTurn = findCutTurn(forked.thread, opts.cutAfterItemId);
        if (!cutTurn) {
            throw new CodexForkRewindPointNotFoundError(opts.cutAfterItemId, opts.threadId);
        }
        const turns = forked.thread.turns ?? [];
        const turnsToDrop = turns.length - cutTurn.index;
        if (turnsToDrop > 0) {
            await client.rollbackThread({
                threadId: forked.threadId,
                numTurns: turnsToDrop,
            });
        }
        await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: cutTurn.text }],
            }],
        });
    }

    return {
        type: 'success',
        newCodexThreadId: forked.threadId,
    };
}
