/**
 * Side questions — Claude Code's `/btw`, asked from the app.
 *
 * `/btw <question>` asks the running Claude something about the conversation
 * without adding to it: Claude answers once from the current context, and
 * neither the question nor the answer becomes a chat message. The CLI serves it
 * through the `side-question` session RPC (happy-cli `claude/sideQuestion.ts`),
 * which works even while Claude is in the middle of a turn.
 *
 * The server drops any RPC that runs past 30 seconds, and an answer over a long
 * conversation can take longer, so one question is a short series of RPCs:
 * `ask` starts it and waits up to 20 seconds, and while the CLI still reports
 * it pending, `askSideQuestion` keeps calling `wait`.
 *
 * Nothing here touches the socket — `sessionSideQuestion` in ops.ts binds the
 * RPC — so this file stays importable from tests and from suggestionCommands.
 */

import { isRigMetadata } from './rig';
import type { Metadata } from './storageTypes';

/** One earlier exchange of the same side thread, so a follow-up has context. */
export type SideQuestionTurn = {
    question: string;
    response: string;
};

export type SideQuestionAnswer = {
    /** Null when Claude produced no answer at all. */
    response: string | null;
    /** True when Claude Code stood in a canned reply for one the model could not give. */
    synthetic: boolean;
};

/**
 * Why the CLI cannot take a side question right now:
 * - `local`: Claude is running in the terminal, out of the app's reach.
 * - `not-started`: no Claude process is running for this session yet; the
 *   next message sent from the app starts one.
 */
export type SideQuestionUnavailableReason = 'local' | 'not-started';

export type SideQuestionResult =
    | { status: 'answered'; answer: SideQuestionAnswer }
    | { status: 'unavailable'; reason: SideQuestionUnavailableReason }
    | { status: 'cancelled' };

export type SideQuestionRpcRequest =
    | { type: 'ask'; question: string; history: SideQuestionTurn[] }
    | { type: 'wait'; id: string }
    | { type: 'cancel'; id: string };

export type SideQuestionRpcResponse =
    | { status: 'pending'; id: string }
    | { status: 'answered'; id: string; answer: SideQuestionAnswer }
    | { status: 'cancelled'; id: string }
    | { status: 'unavailable'; reason: SideQuestionUnavailableReason }
    // A CLI handler that throws comes back as a value, not as a rejection
    | { error: string };

export type SideQuestionRpc = (request: SideQuestionRpcRequest) => Promise<SideQuestionRpcResponse>;

/**
 * The error the server answers with when no CLI registered the RPC — for an
 * online session, a CLI from before side questions existed.
 */
export const SIDE_QUESTION_UNSUPPORTED_ERROR = 'RPC method not available';

/** `/btw what changed?` → `'what changed?'`; a bare `/btw` → `''`; anything else → null. */
export function parseSideQuestionCommand(text: string): string | null {
    const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
    return match ? (match[1] ?? '').trim() : null;
}

/** Side questions need Claude Code: Claude sessions only, and not Happy Agent ones. */
export function supportsSideQuestions(metadata: Metadata | null | undefined): boolean {
    if (!metadata || isRigMetadata(metadata)) {
        return false;
    }
    return !metadata.flavor || metadata.flavor === 'claude';
}

/**
 * Asks a side question over `rpc` and resolves once it is answered. Aborting
 * `signal` stops waiting and tells the CLI to drop the question.
 */
export async function askSideQuestion(
    rpc: SideQuestionRpc,
    question: string,
    history: SideQuestionTurn[],
    signal: AbortSignal,
): Promise<SideQuestionResult> {
    const cancel = (id: string) => {
        rpc({ type: 'cancel', id }).catch(() => { /* the question expires on the CLI anyway */ });
    };

    // Cancels the moment the caller gives up rather than after the current
    // wait comes back, which can be 20 seconds later.
    let pendingId: string | null = null;
    const onAbort = () => {
        if (pendingId) {
            cancel(pendingId);
        }
    };
    signal.addEventListener('abort', onAbort);
    try {
        let response = await rpc({ type: 'ask', question, history });
        while (true) {
            if (signal.aborted) {
                if ('status' in response && response.status === 'pending' && response.id !== pendingId) {
                    cancel(response.id);
                }
                return { status: 'cancelled' };
            }
            if ('error' in response) {
                throw new Error(response.error);
            }
            switch (response.status) {
                case 'answered':
                    return { status: 'answered', answer: response.answer };
                case 'unavailable':
                    return { status: 'unavailable', reason: response.reason };
                case 'cancelled':
                    return { status: 'cancelled' };
            }
            pendingId = response.id;
            response = await rpc({ type: 'wait', id: response.id });
        }
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
