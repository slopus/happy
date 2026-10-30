/**
 * Side questions — Claude Code's `/btw`, asked from the app.
 *
 * `/btw <question>` asks the running Claude something about the conversation
 * without adding to it: Claude answers once, from the current context, with no
 * tools, and neither the question nor the answer is written to the transcript.
 * Claude Code only runs the slash command in its terminal UI — over the SDK it
 * replies "/btw isn't available in this environment" — but the SDK exposes the
 * same feature as the `side_question` control request, which is served even
 * while a turn is running.
 *
 * The app asks over a session RPC, and the server gives up on any RPC after
 * 30 seconds (RPC_CALL_TIMEOUT_MS in happy-server's rpcHandler.ts). Answering
 * from a long conversation can take longer than that, so no single RPC waits
 * for the whole answer: `ask` starts the question and waits up to WAIT_MS for
 * it, and while it is still running the app keeps calling `wait` with the id
 * it got back.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

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

/** Asks the live Claude query a side question. */
export type AskSideQuestion = (
    question: string,
    options: { history: SideQuestionTurn[]; signal: AbortSignal },
) => Promise<SideQuestionAnswer>;

/**
 * Why a side question cannot be asked right now — expected states the app
 * explains in its own words, not failures:
 * - `local`: Claude is running in the terminal, out of the app's reach.
 * - `not-started`: no Claude process is running for this session yet; one
 *   starts with the next message sent from the app.
 */
export type SideQuestionUnavailableReason = 'local' | 'not-started';

export type SideQuestionRpcResponse =
    | { status: 'pending'; id: string }
    | { status: 'answered'; id: string; answer: SideQuestionAnswer }
    | { status: 'cancelled'; id: string }
    | { status: 'unavailable'; reason: SideQuestionUnavailableReason };

const SideQuestionRpcRequestSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('ask'),
        question: z.string().trim().min(1),
        history: z.array(z.object({ question: z.string(), response: z.string() })).optional(),
    }),
    z.object({ type: z.literal('wait'), id: z.string() }),
    z.object({ type: z.literal('cancel'), id: z.string() }),
]);

export type SideQuestionRpcRequest = z.infer<typeof SideQuestionRpcRequestSchema>;

/** How long one RPC waits for the answer — well inside the server's 30 s cutoff. */
const WAIT_MS = 20_000;

/** A question still unanswered, or answered but never collected, after this long is dropped. */
const LIFETIME_MS = 10 * 60_000;

type Outcome = { ok: true; answer: SideQuestionAnswer } | { ok: false; error: Error };

type InFlightQuestion = {
    controller: AbortController;
    outcome: Promise<Outcome>;
    expiry: NodeJS.Timeout;
};

/**
 * Builds the `side-question` RPC handler. `resolveAsk` returns the live
 * query's ask function, or the reason there is none.
 */
export function createSideQuestionHandler(
    resolveAsk: () => AskSideQuestion | SideQuestionUnavailableReason,
    options: { waitMs?: number } = {},
): (params: unknown) => Promise<SideQuestionRpcResponse> {
    const waitMs = options.waitMs ?? WAIT_MS;
    const questions = new Map<string, InFlightQuestion>();

    const forget = (id: string) => {
        const question = questions.get(id);
        if (question) {
            clearTimeout(question.expiry);
            questions.delete(id);
        }
    };

    const waitFor = async (id: string, question: InFlightQuestion): Promise<SideQuestionRpcResponse> => {
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
            question.outcome,
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), waitMs);
            }),
        ]);
        clearTimeout(timer);
        if (!outcome) {
            return { status: 'pending', id };
        }
        forget(id);
        if (!outcome.ok) {
            throw outcome.error;
        }
        return { status: 'answered', id, answer: outcome.answer };
    };

    return async (params: unknown) => {
        const parsed = SideQuestionRpcRequestSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid side question request');
        }
        const request = parsed.data;

        if (request.type === 'cancel') {
            questions.get(request.id)?.controller.abort();
            forget(request.id);
            return { status: 'cancelled', id: request.id };
        }

        if (request.type === 'wait') {
            const question = questions.get(request.id);
            if (!question) {
                throw new Error('This side question is no longer available — ask it again');
            }
            return await waitFor(request.id, question);
        }

        const ask = resolveAsk();
        if (typeof ask === 'string') {
            return { status: 'unavailable', reason: ask };
        }

        const id = randomUUID();
        const controller = new AbortController();
        const expiry = setTimeout(() => {
            controller.abort();
            questions.delete(id);
        }, LIFETIME_MS);
        expiry.unref();
        const question: InFlightQuestion = {
            controller,
            expiry,
            // Settles to a value rather than rejecting, so a question nobody is
            // waiting on — cancelled, or abandoned by an app that went away —
            // never surfaces as an unhandled rejection.
            outcome: ask(request.question, { history: request.history ?? [], signal: controller.signal }).then(
                (answer): Outcome => ({ ok: true, answer }),
                (error: unknown): Outcome => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
            ),
        };
        questions.set(id, question);
        return await waitFor(id, question);
    };
}
