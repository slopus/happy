import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn as crossSpawn } from 'cross-spawn';

import type { OffTurnTitleRunner } from '@/utils/offTurnTitle';

/**
 * Codex runner for off-turn chat titles (see utils/offTurnTitle): an ephemeral
 * read-only `codex exec` launched with the app-server's payer and sandbox.
 */

const DEFAULT_TIMEOUT_MS = 45_000;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
/**
 * Plugin- and app-provided MCP servers are listed by `codex mcp list` but are
 * not tables in config.toml, so `-c mcp_servers.<name>.enabled=false` on one
 * creates a server without a transport and Codex refuses to load its config.
 * Turning both features off leaves only config-defined servers to disable.
 */
const PLUGIN_SERVER_EXCLUSION = ['-c', 'features.plugins=false', '-c', 'features.apps=false'];

const OFF_TURN_TITLE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        branchSlug: { type: 'string' },
    },
    required: ['title', 'branchSlug'],
    additionalProperties: false,
} as const;

/**
 * The title exec runs with the app-server's own payer and sandbox (see
 * CodexAppServerClient.prepareSideCommand), so it is allowed wherever a side
 * command is. Run-once hosts keep the in-turn instruction: they may exit
 * before a parallel title lands.
 */
export function isOffTurnTitleEligible(input: {
    sideCommandAllowed: boolean;
    exitAfterFirstTurn: boolean;
}): boolean {
    return input.sideCommandAllowed && !input.exitAfterFirstTurn;
}

export type CodexCommandLaunch = { command: string; args: string[]; env: NodeJS.ProcessEnv };
export type PrepareCodexCommand = (args: string[]) => Promise<CodexCommandLaunch | null>;

const plainCodexCommand: PrepareCodexCommand = async (args) => ({ command: 'codex', args, env: process.env });

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
        ...PLUGIN_SERVER_EXCLUSION,
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

const MAX_ERROR_LINE_LENGTH = 200;
/** Same grace as the app-server's own shutdown before it escalates to SIGKILL. */
const KILL_GRACE_MS = 2_000;
const TOKEN_LIKE_RUN = /[A-Za-z0-9_\-+/=.]{24,}/g;

/**
 * The first `Error...` line of a failed command, for the warn log. Other
 * stderr is dropped and long token-like runs are masked: stderr can carry
 * provider auth detail.
 */
function reportableErrorLine(stderr: string): string | null {
    const line = stderr.split('\n').map((value) => value.trim()).find((value) => value.startsWith('Error'));
    return line ? line.replace(TOKEN_LIKE_RUN, '<redacted>').slice(0, MAX_ERROR_LINE_LENGTH) : null;
}

/**
 * Runs one codex command in `cwd`, writing `input` to stdin when given, and
 * resolves with its stdout. It is killed on abort or once `timeoutMs` passes.
 */
async function runCodexCommand(spawnImpl: typeof crossSpawn, prepare: PrepareCodexCommand, args: string[], opts: {
    cwd: string;
    input?: string;
    signal: AbortSignal;
    timeoutMs: number;
}): Promise<string> {
    const launch = await prepare(args);
    if (!launch) throw new Error(`codex ${args[0]} launch unavailable`);
    const child = spawnImpl(launch.command, launch.args, {
        cwd: opts.cwd,
        env: launch.env,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    // An exec that exits before reading its prompt fails the write with EPIPE;
    // unhandled, that stream error would take down the whole session process.
    // The exit code below already reports the failure.
    child.stdin?.on('error', () => {});
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString(); });
    const label = `codex ${args[0]}`;
    return new Promise<string>((resolve, reject) => {
        let stopReason: string | null = null;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (reason: string) => {
            if (stopReason) return;
            stopReason = reason;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
            killTimer.unref?.();
        };
        const onAbort = () => stop('aborted');
        const timer = setTimeout(() => stop(`timed out after ${opts.timeoutMs}ms`), opts.timeoutMs);
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
        const finish = (error?: Error) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            opts.signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(stdout);
        };
        child.once('error', (error) => finish(error));
        child.once('close', (code: number | null) => {
            if (stopReason) finish(new Error(`${label} ${stopReason}`));
            else if (code !== 0) {
                const detail = reportableErrorLine(stderr);
                finish(new Error(`${label} exited with code ${code}${detail ? `: ${detail}` : ''}`));
            }
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
export function createCodexExecTitleRunner(opts: { timeoutMs?: number; spawnImpl?: typeof crossSpawn; prepare?: PrepareCodexCommand } = {}): OffTurnTitleRunner {
    const spawnImpl = opts.spawnImpl ?? crossSpawn;
    const prepare = opts.prepare ?? plainCodexCommand;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return async ({ prompt, model, signal }) => {
        const deadline = Date.now() + timeoutMs;
        const dir = await mkdtemp(join(tmpdir(), 'happy-codex-title-'));
        try {
            const listed = await runCodexCommand(spawnImpl, prepare, ['mcp', 'list', ...PLUGIN_SERVER_EXCLUSION, '--json'], { cwd: dir, signal, timeoutMs });
            const mcpServerNames = parseEnabledMcpServerNames(listed);
            if (!mcpServerNames) throw new Error('codex mcp list has an MCP server that cannot be disabled by name');
            const schemaPath = join(dir, 'schema.json');
            const outputPath = join(dir, 'title.json');
            await writeFile(schemaPath, JSON.stringify(OFF_TURN_TITLE_SCHEMA));
            await runCodexCommand(spawnImpl, prepare, buildOffTurnTitleExecArgs({ model, schemaPath, outputPath, mcpServerNames }), {
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
