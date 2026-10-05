import { BRANCH_SLUG_SPEC } from '@/utils/branchSlugSpec';

/**
 * Titles a new chat outside the user's turn, for any provider.
 *
 * The in-turn change_title instruction costs extra model round trips on the
 * first request (find the deferred change_title tool, then call it). A
 * provider-specific runner produces the same locked title in parallel instead;
 * a run that fails stops covering the title, so the next turn falls back to
 * the in-turn instruction.
 */

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 4000;
const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/;

export type OffTurnTitleRunner = (input: { prompt: string; model?: string; signal: AbortSignal }) => Promise<string | null>;

export interface OffTurnTitleJobDeps {
    run: OffTurnTitleRunner;
    changeTitle: (title: string, branchSlug?: string) => Promise<{ success: boolean; error?: string }>;
    hasTitle: () => boolean;
    log: (message: string, detail?: unknown) => void;
}

export function buildOffTurnTitlePrompt(message: string): string {
    return [
        'Write a title for a chat that starts with the user message below. Do not answer the message and do not run any commands.',
        "title: a concise noun phrase in the user's language that names the user's task.",
        `branchSlug: ${BRANCH_SLUG_SPEC}`,
        'User message:',
        message.slice(0, MAX_MESSAGE_LENGTH),
    ].join('\n\n');
}

export function parseOffTurnTitle(raw: string | null): { title: string; branchSlug?: string } | null {
    if (!raw) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== 'object') return null;
    const { title, branchSlug } = value as { title?: unknown; branchSlug?: unknown };
    if (typeof title !== 'string') return null;
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > MAX_TITLE_LENGTH) return null;
    const slug = typeof branchSlug === 'string' ? branchSlug.trim() : '';
    return BRANCH_SLUG_PATTERN.test(slug) ? { title: trimmed, branchSlug: slug } : { title: trimmed };
}

export function createOffTurnTitleJob(deps: OffTurnTitleJobDeps) {
    let state: 'idle' | 'running' | 'done' | 'failed' = 'idle';
    const controller = new AbortController();
    let settledPromise: Promise<void> = Promise.resolve();

    const fail = (reason: string, detail?: unknown) => {
        state = 'failed';
        deps.log(`[Codex] off-turn title ${reason}`, detail ?? null);
    };

    const execute = async (message: string, model: string | undefined) => {
        let raw: string | null;
        try {
            raw = await deps.run({ prompt: buildOffTurnTitlePrompt(message), model, signal: controller.signal });
        } catch (error) {
            if (!controller.signal.aborted) fail('run failed', error);
            return;
        }
        if (controller.signal.aborted) return;
        const parsed = parseOffTurnTitle(raw);
        if (!parsed) { fail('failed: output was not a valid title'); return; }
        if (deps.hasTitle()) { state = 'done'; return; }
        const result = await deps.changeTitle(parsed.title, parsed.branchSlug);
        if (result.success || deps.hasTitle()) { state = 'done'; return; }
        fail('failed to record title', result.error);
    };

    return {
        start(message: string, model: string | undefined): boolean {
            if (state !== 'idle' || deps.hasTitle()) return false;
            state = 'running';
            // Nothing awaits this in production; a rejection would be unhandled.
            settledPromise = execute(message, model).catch((error: unknown) => fail('failed unexpectedly', error));
            return true;
        },
        /** True while the in-turn title instruction can be left out. */
        covers(): boolean {
            return state === 'running' || state === 'done';
        },
        cancel(): void {
            controller.abort();
            if (state === 'running') state = 'failed';
        },
        settled(): Promise<void> {
            return settledPromise;
        },
    };
}

export type OffTurnTitleJob = ReturnType<typeof createOffTurnTitleJob>;

/**
 * Decides, per turn, whether the in-turn title instruction can be left out.
 * An eligible untitled turn starts the job (once); after a failed job this
 * returns false again so the turn carries the instruction as before.
 */
export function titleCoveredForTurn(input: {
    hasTitle: boolean;
    job: OffTurnTitleJob;
    eligible: boolean;
    message: string;
    model?: string;
}): boolean {
    if (input.hasTitle) return true;
    if (input.eligible) input.job.start(input.message, input.model);
    return input.job.covers();
}
