import type { ThreadGoalClearResponse, ThreadGoalSetParams, ThreadGoalSetResponse } from './codexAppServerTypes';
import { parseCodexGoalCommand, type CodexGoalCommand } from './codexGoalStatus';

type CodexGoalCommandClient = {
    supportsGoalActions: () => boolean;
    setGoal: (opts: {
        threadId: string;
        objective?: string;
        status?: ThreadGoalSetParams['status'];
    }) => Promise<ThreadGoalSetResponse>;
    clearGoal: (opts: { threadId: string }) => Promise<ThreadGoalClearResponse>;
};

export type CodexGoalMutationContext = {
    threadId: string;
    threadEpoch: number;
};

export function codexGoalCommandRequiresExistingThread(command: CodexGoalCommand): boolean {
    return command.type !== 'set';
}

export function createCodexGoalMutationQueue(
    getCurrentContext: () => { threadId: string | null; threadEpoch: number },
): <T>(context: CodexGoalMutationContext, operation: (assertCurrent: () => void) => Promise<T>) => Promise<T> {
    let tail: Promise<void> = Promise.resolve();

    return <T>(
        context: CodexGoalMutationContext,
        operation: (assertCurrent: () => void) => Promise<T>,
    ): Promise<T> => {
        const result = tail.then(async () => {
            const assertCurrent = () => assertCodexGoalMutationContext(context, getCurrentContext());
            assertCurrent();
            const value = await operation(assertCurrent);
            assertCurrent();
            return value;
        });
        tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
}

export function assertCodexGoalMutationContext(
    captured: CodexGoalMutationContext,
    current: { threadId: string | null; threadEpoch: number },
): void {
    if (current.threadEpoch !== captured.threadEpoch || current.threadId !== captured.threadId) {
        throw new Error('Codex goal action is stale because the active thread changed');
    }
}

export async function executeCodexGoalCommand(opts: {
    client: CodexGoalCommandClient;
    command: CodexGoalCommand;
    threadId: string;
    publishEvent: (event: Record<string, unknown>) => void;
    reportStatus: (message: string) => void;
    assertCurrent?: () => void;
}): Promise<void> {
    if (!opts.client.supportsGoalActions()) {
        throw new Error('Codex goal actions require Codex CLI 0.140.0 or newer');
    }

    if (opts.command.type === 'edit') {
        throw new Error('Use the Goal Edit action to provide a revised objective');
    }

    if (opts.command.type === 'clear') {
        const result = await opts.client.clearGoal({ threadId: opts.threadId });
        opts.assertCurrent?.();
        if (result.cleared !== false) {
            opts.publishEvent({
                type: 'thread_goal_cleared',
                threadId: opts.threadId,
            });
        }
        opts.reportStatus('Goal cleared');
        return;
    }

    const result = opts.command.type === 'set-status'
        ? await opts.client.setGoal({ threadId: opts.threadId, status: opts.command.status })
        : await opts.client.setGoal({ threadId: opts.threadId, objective: opts.command.objective });
    opts.assertCurrent?.();
    opts.publishEvent({
        type: 'thread_goal_updated',
        threadId: opts.threadId,
        goal: result.goal,
    });
    if (opts.command.type === 'set-status') {
        opts.reportStatus(opts.command.status === 'paused' ? 'Goal paused' : 'Goal resumed');
    } else {
        opts.reportStatus('Goal updated');
    }
}

/**
 * Typed /goal commands are control-plane input, even when the app-server
 * rejects them. Returning true prevents a failed action from becoming a
 * normal Codex prompt (for example, setting the objective to resume).
 */
export async function consumeCodexGoalCommandText(opts: {
    text: string;
    execute: (command: CodexGoalCommand) => Promise<void>;
    onError: (error: unknown) => void;
}): Promise<boolean> {
    const command = parseCodexGoalCommand(opts.text);
    if (!command) {
        return false;
    }

    try {
        await opts.execute(command);
    } catch (error) {
        opts.onError(error);
    }
    return true;
}
