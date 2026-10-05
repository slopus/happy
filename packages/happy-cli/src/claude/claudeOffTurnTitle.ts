import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OffTurnTitleRunner } from '@/utils/offTurnTitle';

import { query } from './sdk/query';
import type { QueryOptions } from './sdk/types';

/**
 * Claude runner for off-turn chat titles (see utils/offTurnTitle).
 *
 * claudeRemote provides the options of the query it is about to run; the title
 * query reuses what decides the payer and the sandbox (cwd, setting sources,
 * SDK sandbox, permission denies, and — inside the `query` wrapper — the same
 * executable and environment) and turns everything else off: no tools, no MCP
 * servers, no hooks, no session file, one low-effort turn.
 */

const DEFAULT_WAIT_MS = 45_000;

const CLAUDE_TITLE_SYSTEM_PROMPT = 'You write chat titles. Reply with only a JSON object {"title": string, "branchSlug": string} and nothing else.';

export function buildClaudeTitleQueryOptions(base: QueryOptions, input: {
    model?: string;
    settingsPath: string;
    signal: AbortSignal;
}): QueryOptions {
    return {
        cwd: base.cwd,
        settingSources: base.settingSources,
        sandbox: base.sandbox,
        permissionsDeny: base.permissionsDeny,
        model: input.model ?? base.model,
        effort: 'low',
        customSystemPrompt: CLAUDE_TITLE_SYSTEM_PROMPT,
        tools: [],
        strictMcpConfig: true,
        maxTurns: 1,
        persistSession: false,
        settingsPath: input.settingsPath,
        abort: input.signal,
    };
}

/** The first `{...}` span of a reply, which may arrive fenced or wrapped in prose. */
export function extractTitleJson(text: string | null): string | null {
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

type RunQuery = (params: { prompt: string; options?: QueryOptions }) => AsyncIterable<unknown>;

/**
 * Connects the title job, started when a message is queued, to the options
 * claudeRemote settles once it handles that message. `run` waits for
 * `provide` (bounded by `waitMs` and the job's signal); `clear` withdraws the
 * options when that query ends, so a later run never reuses a stale launch.
 */
export function createClaudeTitleBridge(opts: { runQuery?: RunQuery; waitMs?: number } = {}) {
    const runQuery = opts.runQuery ?? (query as RunQuery);
    const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
    let provided: QueryOptions | null = null;
    const waiters = new Set<(options: QueryOptions) => void>();

    const waitForOptions = (signal: AbortSignal) => new Promise<QueryOptions>((resolve, reject) => {
        if (provided) { resolve(provided); return; }
        const done = (error: Error | null, options?: QueryOptions) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            waiters.delete(onProvide);
            if (error) reject(error); else resolve(options!);
        };
        const onProvide = (options: QueryOptions) => done(null, options);
        const onAbort = () => done(new Error('Claude title query aborted'));
        const timer = setTimeout(() => done(new Error('Claude title query launch unavailable')), waitMs);
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        waiters.add(onProvide);
    });

    const run: OffTurnTitleRunner = async ({ prompt, model, signal }) => {
        const base = await waitForOptions(signal);
        const dir = await mkdtemp(join(tmpdir(), 'happy-claude-title-'));
        try {
            const settingsPath = join(dir, 'settings.json');
            // User and plugin hooks (SessionStart, memory capture, ...) must not
            // run for a title.
            await writeFile(settingsPath, JSON.stringify({ disableAllHooks: true }));
            let result: string | null = null;
            for await (const message of runQuery({ prompt, options: buildClaudeTitleQueryOptions(base, { model, settingsPath, signal }) })) {
                const value = message as { type?: string; subtype?: string; result?: unknown };
                if (value.type !== 'result') continue;
                if (value.subtype !== 'success') throw new Error(`Claude title query ended with ${value.subtype}`);
                result = typeof value.result === 'string' ? value.result : null;
            }
            return extractTitleJson(result);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    };

    return {
        provide(options: QueryOptions): void {
            provided = options;
            for (const waiter of [...waiters]) waiter(options);
        },
        clear(): void {
            provided = null;
        },
        run,
    };
}

export type ClaudeTitleBridge = ReturnType<typeof createClaudeTitleBridge>;
