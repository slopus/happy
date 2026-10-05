import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn as crossSpawn } from 'cross-spawn';

import { BRANCH_SLUG_SPEC } from '@/utils/branchSlugSpec';

import type { CodexAuthSource } from './codexAuthRecovery';

/**
 * Titles a new Codex chat outside the user's turn.
 *
 * The in-turn CHANGE_TITLE_INSTRUCTION costs Codex two extra model round trips
 * on the first request (find the deferred change_title tool, then call it),
 * measured at roughly 4-7s before the answer. A separate ephemeral exec writes
 * the same locked title in parallel instead. A run that fails stops covering
 * the title, so the next turn falls back to the in-turn instruction.
 */

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 45_000;
const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export const OFF_TURN_TITLE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        branchSlug: { type: 'string' },
    },
    required: ['title', 'branchSlug'],
    additionalProperties: false,
} as const;

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

/**
 * Only sessions whose app-server runs with the user's own Codex login and no
 * wrapping sandbox: a plain `codex exec` then has the same payer and the same
 * permissions as the user running Codex themselves. Managed/multi-auth
 * providers and sandboxed or run-once hosts keep the in-turn instruction.
 */
export function isOffTurnTitleEligible(input: {
    authSource: CodexAuthSource;
    sandboxEnabled: boolean;
    exitAfterFirstTurn: boolean;
}): boolean {
    return (input.authSource === 'cli-login' || input.authSource === 'custom-home')
        && !input.sandboxEnabled
        && !input.exitAfterFirstTurn;
}

/**
 * Names of the enabled MCP servers in `codex mcp list --json` output, or null
 * when the output is unreadable or a name cannot be addressed by a `-c` key.
 * Codex deep-merges `-c mcp_servers={}` into the user's table, and it splits
 * `-c` keys on every dot, so each server is disabled by its own plain name.
 */
export function parseEnabledMcpServerNames(raw: string): string[] | null {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(value)) return null;
    const names: string[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') return null;
        const { name, enabled } = entry as { name?: unknown; enabled?: unknown };
        if (typeof name !== 'string') return null;
        if (enabled === false) continue;
        if (!MCP_SERVER_NAME_PATTERN.test(name)) return null;
        names.push(name);
    }
    return names;
}

export function buildOffTurnTitleExecArgs(input: { model?: string; schemaPath: string; outputPath: string; mcpServerNames: string[] }): string[] {
    return [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s', 'read-only',
        '-c', 'model_reasoning_effort="low"',
        ...input.mcpServerNames.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
        ...(input.model ? ['-m', input.model] : []),
        '--output-schema', input.schemaPath,
        '-o', input.outputPath,
        '-',
    ];
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
            settledPromise = execute(message, model);
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

/**
 * Runs one codex command in `cwd`, writing `input` to stdin when given, and
 * resolves with its stdout. It is killed on abort or once `timeoutMs` passes.
 * stderr is drained but not surfaced: it can carry provider auth detail.
 */
function runCodexCommand(spawnImpl: typeof crossSpawn, args: string[], opts: {
    cwd: string;
    input?: string;
    signal: AbortSignal;
    timeoutMs: number;
}): Promise<string> {
    const child = spawnImpl('codex', args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.resume();
    const label = `codex ${args[0]}`;
    return new Promise<string>((resolve, reject) => {
        let stopReason: string | null = null;
        const stop = (reason: string) => { stopReason = reason; child.kill(); };
        const onAbort = () => stop('aborted');
        const timer = setTimeout(() => stop(`timed out after ${opts.timeoutMs}ms`), opts.timeoutMs);
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
        const finish = (error?: Error) => {
            clearTimeout(timer);
            opts.signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(stdout);
        };
        child.once('error', (error) => finish(error));
        child.once('close', (code: number | null) => {
            if (stopReason) finish(new Error(`${label} ${stopReason}`));
            else if (code !== 0) finish(new Error(`${label} exited with code ${code}`));
            else finish();
        });
        if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
}

/**
 * Runs the title prompt through `codex exec` in an empty temp dir (no project
 * AGENTS.md), passing the user message on stdin so it never shows in argv.
 * Every MCP server the user configured is disabled by name first; when one
 * cannot be, the run fails and the turn keeps the in-turn instruction.
 */
export function createCodexExecTitleRunner(opts: { timeoutMs?: number; spawnImpl?: typeof crossSpawn } = {}): OffTurnTitleRunner {
    const spawnImpl = opts.spawnImpl ?? crossSpawn;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return async ({ prompt, model, signal }) => {
        const deadline = Date.now() + timeoutMs;
        const dir = await mkdtemp(join(tmpdir(), 'happy-codex-title-'));
        try {
            const listed = await runCodexCommand(spawnImpl, ['mcp', 'list', '--json'], { cwd: dir, signal, timeoutMs });
            const mcpServerNames = parseEnabledMcpServerNames(listed);
            if (!mcpServerNames) throw new Error('codex mcp list has an MCP server that cannot be disabled by name');
            const schemaPath = join(dir, 'schema.json');
            const outputPath = join(dir, 'title.json');
            await writeFile(schemaPath, JSON.stringify(OFF_TURN_TITLE_SCHEMA));
            await runCodexCommand(spawnImpl, buildOffTurnTitleExecArgs({ model, schemaPath, outputPath, mcpServerNames }), {
                cwd: dir,
                input: prompt,
                signal,
                timeoutMs: Math.max(deadline - Date.now(), 0),
            });
            return await readFile(outputPath, 'utf8').catch(() => null);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    };
}
