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
        lastTurnId?: string;
        beforeTurnId?: string;
        cwd?: string;
        model?: string;
        approvalPolicy?: any;
        sandbox?: any;
        mcpServers?: Record<string, unknown>;
        deferGoalContinuation?: boolean;
    }) => Promise<{ threadId: string; thread: Thread }>;
    readThread: (opts: { threadId: string; includeTurns: boolean }) => Promise<{ thread: Thread }>;
    deleteThread: (opts: { threadId: string }) => Promise<unknown>;
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

function findCutTurn(thread: Thread, itemId: string): { index: number; itemIndex: number; text: string } | null {
    const turns = thread.turns ?? [];
    for (let index = 0; index < turns.length; index++) {
        const turn = turns[index];
        const itemIndex = (turn.items ?? []).findIndex((candidate) => candidate.id === itemId);
        const item = turn.items?.[itemIndex];
        if (!item) {
            continue;
        }
        const text = textFromUserItem(item);
        if (text) {
            return { index, itemIndex, text };
        }
    }
    return null;
}

export async function forkCodexThread(
    client: CodexForkClient,
    opts: {
        threadId: string;
        lastTurnId?: string;
        cwd?: string;
        cutAfterItemId?: string;
        cutBeforeItemId?: string;
        retainSelectedTurn?: boolean;
        model?: string;
        approvalPolicy?: any;
        sandbox?: any;
        mcpServers?: Record<string, unknown>;
        deferGoalContinuation?: boolean;
    },
): Promise<CodexForkResult> {
    // Resolve the boundary on the source before creating anything. Paginated
    // Codex threads cannot be rolled back after a full fork.
    let cut: { turnId: string; text: string; retainedTurnIds: string[] } | undefined;
    const boundaryItemId = opts.cutBeforeItemId ?? opts.cutAfterItemId;
    if (boundaryItemId) {
        if (opts.lastTurnId || (opts.cutBeforeItemId && (opts.cutAfterItemId || opts.retainSelectedTurn))) {
            throw new Error('Cannot combine Codex fork boundaries');
        }
        const { thread } = await client.readThread({ threadId: opts.threadId, includeTurns: true });
        const selected = findCutTurn(thread, boundaryItemId);
        if (!selected) {
            throw new CodexForkRewindPointNotFoundError(boundaryItemId, opts.threadId);
        }
        if (opts.cutBeforeItemId && selected.itemIndex > 0) {
            throw new Error('Cannot fork before a question inside a Codex turn without removing earlier history');
        }
        cut = {
            turnId: thread.turns![selected.index].id,
            text: selected.text,
            retainedTurnIds: thread.turns!.slice(0, selected.index + (opts.retainSelectedTurn ? 1 : 0)).map(turn => turn.id),
        };
    }
    const forked = await client.forkThread({
        threadId: opts.threadId,
        ...(opts.lastTurnId ? { lastTurnId: opts.lastTurnId } : {}),
        ...(cut ? (opts.retainSelectedTurn
            ? { lastTurnId: cut.turnId }
            : { beforeTurnId: cut.turnId }) : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        ...((cut || opts.deferGoalContinuation !== undefined)
            ? { deferGoalContinuation: cut ? true : opts.deferGoalContinuation }
            : {}),
    });

    if (cut) {
        try {
            // Older servers may silently ignore unknown boundary fields. Check
            // the persisted fork before returning it or restoring the prompt.
            const { thread } = await client.readThread({ threadId: forked.threadId, includeTurns: true });
            const retainedIds = thread.turns?.map(turn => turn.id);
            if (!retainedIds || JSON.stringify(retainedIds) !== JSON.stringify(cut.retainedTurnIds)) {
                throw new Error('Codex did not preserve the requested fork boundary; update Codex and try again');
            }
            if (!opts.retainSelectedTurn && !opts.cutBeforeItemId) {
                await client.injectItems({
                    threadId: forked.threadId,
                    items: [{
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: cut.text }],
                    }],
                });
            }
        } catch (error) {
            // Best-effort cleanup, without masking the original failure.
            await client.deleteThread({ threadId: forked.threadId }).catch(() => undefined);
            throw error;
        }
    }

    return {
        type: 'success',
        newCodexThreadId: forked.threadId,
    };
}
