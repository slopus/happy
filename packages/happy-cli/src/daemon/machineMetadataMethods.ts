/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary D4-2 — metadata the web
 * server needs about a strict machine, answered on the server lane.
 *
 * Every answer has a fixed shape and carries no file content, no file or
 * changed-file listing and no command output: counts, booleans, branch names,
 * a login name, port numbers with a coarse process kind, platform and CLI
 * version. Paths stay inside the daemon's allowed root and out of the happy
 * home, through the same boundary as the workspace file handlers.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { request } from 'node:http';
import { captureWorkspacePath } from '@/modules/common/workspaceFileBoundary';
import { isWithinDirectory } from '@/modules/common/happyHomeGuard';

export const METADATA_METHODS = [
    'workspace-path-stat',
    'workspace-git-info',
    'preview-liveness',
    'listening-ports',
    'container-runtime-status',
    'gh-auth-status',
    'machine-info',
] as const;

export type MetadataMethod = typeof METADATA_METHODS[number];

export interface MetadataDeps {
    allowedRoot: string;
    happyHomeDir: string;
    platform: string;
    cliVersion: string;
    /** Runs a program without a shell. Rejects only when the program cannot start. */
    runFile: (
        command: string,
        args: string[],
        options: { cwd?: string; env: Record<string, string>; timeoutMs: number },
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
    /** GET http://127.0.0.1:<port>/ and report the status, or null when nothing answers. */
    probeHttp: (port: number) => Promise<{ status: number } | null>;
}

type Answer = Record<string, unknown>;
type Handler = (params: unknown) => Promise<Answer>;

const MAX_BRANCHES = 200;
const MAX_PORTS = 500;
const MAX_ENTRY_COUNT = 10_000;

function failure(errorCode: string, error: string): Answer {
    return { success: false, errorCode, error };
}

function errorCode(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function pathParams(params: unknown): { workspaceRoot: string; path: string } | null {
    if (!params || typeof params !== 'object') return null;
    const { workspaceRoot, path } = params as Record<string, unknown>;
    return typeof workspaceRoot === 'string' && typeof path === 'string' ? { workspaceRoot, path } : null;
}

function baseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'LANG']) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    return env;
}

const DENIED = failure('WORKSPACE_PATH_DENIED', 'Workspace path is outside the project or in the happy home directory');

export function createMachineMetadataHandlers(deps: MetadataDeps): Record<MetadataMethod, Handler> {
    const inHappyHome = (...paths: string[]) => paths.some((path) => isWithinDirectory(path, deps.happyHomeDir));

    const git = (cwd: string, args: string[]) => deps.runFile('git', [
        // Repository config must not make a server-lane call run commands.
        '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args,
    ], { env: { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 10_000 });

    return {
        'workspace-path-stat': async (params) => {
            const input = pathParams(params);
            if (!input) return failure('INVALID_PARAMS', 'workspaceRoot and path are required');
            if (inHappyHome(input.workspaceRoot, input.path)) return DENIED;
            try {
                const snapshot = await captureWorkspacePath(deps.allowedRoot, input.workspaceRoot, input.path);
                if (!snapshot.info.isDirectory()) return { success: true, exists: true, isDirectory: false, entryCount: null };
                const names = await readdir(snapshot.path);
                await snapshot.verify();
                return { success: true, exists: true, isDirectory: true, entryCount: Math.min(names.length, MAX_ENTRY_COUNT) };
            } catch (error) {
                if (errorCode(error) === 'ENOENT') return { success: true, exists: false, isDirectory: false, entryCount: null };
                return DENIED;
            }
        },

        'workspace-git-info': async (params) => {
            const input = pathParams(params);
            if (!input) return failure('INVALID_PARAMS', 'workspaceRoot and path are required');
            if (inHappyHome(input.workspaceRoot, input.path)) return DENIED;
            let dir: string;
            try {
                const snapshot = await captureWorkspacePath(deps.allowedRoot, input.workspaceRoot, input.path);
                if (!snapshot.info.isDirectory()) return DENIED;
                dir = snapshot.path;
            } catch {
                return DENIED;
            }
            const notRepo = { success: true, isGitRepo: false, branch: null, localBranches: [], changedCount: 0 };
            try {
                const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
                if (inside.code !== 0 || inside.stdout.trim() !== 'true') return notRepo;
                const [branch, refs, status] = await Promise.all([
                    git(dir, ['branch', '--show-current']),
                    git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
                    git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
                ]);
                const current = branch.code === 0 ? branch.stdout.trim() : '';
                return {
                    success: true,
                    isGitRepo: true,
                    branch: current || null,
                    localBranches: refs.code === 0
                        ? refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_BRANCHES)
                        : [],
                    changedCount: status.code === 0 ? countPorcelainEntries(status.stdout) : 0,
                };
            } catch (error) {
                if (errorCode(error) === 'ENOENT') return { ...notRepo, success: false, errorCode: 'GIT_UNAVAILABLE', error: 'git is not installed' };
                throw error;
            }
        },

        'preview-liveness': async (params) => {
            const port = (params as { port?: unknown } | null)?.port;
            if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
                return failure('INVALID_PARAMS', 'port must be a TCP port number');
            }
            const answer = await deps.probeHttp(port).catch(() => null);
            if (!answer) return { success: true, up: false, statusCode: null };
            return { success: true, up: answer.status >= 200 && answer.status < 500, statusCode: answer.status };
        },

        'listening-ports': async () => {
            if (deps.platform === 'win32') return failure('UNSUPPORTED_PLATFORM', 'listening-ports is not available on Windows');
            try {
                const result = await deps.runFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'], { env: baseEnv(), timeoutMs: 10_000 });
                // lsof exits 1 when nothing listens.
                if (result.code !== 0 && result.code !== 1) return failure('PORTS_UNAVAILABLE', 'Could not list listening ports');
                return { success: true, ports: parseListeningPorts(result.stdout) };
            } catch {
                return failure('PORTS_UNAVAILABLE', 'Could not list listening ports');
            }
        },

        'container-runtime-status': async () => {
            try {
                const result = await deps.runFile('docker', ['version', '--format', '{{.Server.Version}}'], { env: baseEnv(), timeoutMs: 10_000 });
                return { success: true, available: result.code === 0 && result.stdout.trim().length > 0 };
            } catch {
                return { success: true, available: false };
            }
        },

        'gh-auth-status': async () => {
            try {
                const result = await deps.runFile('gh', ['auth', 'status', '--hostname', 'github.com'], {
                    env: { ...baseEnv(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeoutMs: 10_000,
                });
                const account = parseGhAccount(`${result.stdout}\n${result.stderr}`);
                return { success: true, installed: true, loggedIn: result.code === 0 && account !== null, account: result.code === 0 ? account : null };
            } catch (error) {
                if (errorCode(error) === 'ENOENT') return { success: true, installed: false, loggedIn: false, account: null };
                return failure('GH_UNAVAILABLE', 'Could not read gh login status');
            }
        },

        'machine-info': async () => ({ success: true, platform: deps.platform, cliVersion: deps.cliVersion }),
    };
}

/** `git status --porcelain=v1 -z`: entries are NUL-separated; a rename carries its source as an extra field. */
export function countPorcelainEntries(output: string): number {
    const fields = output.split('\0');
    let count = 0;
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field.length < 3) continue;
        count++;
        if (field[0] === 'R' || field[0] === 'C') index++;
    }
    return count;
}

const PROCESS_KINDS: Array<[RegExp, string]> = [
    [/^(node|bun|deno)$/, 'node'],
    [/^python/, 'python'],
    [/^(docker|com\.docke|vpnkit|containerd)/, 'docker'],
    [/^(java)$/, 'java'],
    [/^(ruby|puma)$/, 'ruby'],
];

/** `lsof -F pcn` records: `p<pid>`, `c<command>`, `n<address>`. Only the port and a coarse kind leave. */
export function parseListeningPorts(output: string): Array<{ port: number; kind: string }> {
    const ports = new Map<number, string>();
    let kind = 'other';
    for (const line of output.split('\n')) {
        if (line.startsWith('p')) kind = 'other';
        else if (line.startsWith('c')) {
            const command = line.slice(1);
            kind = PROCESS_KINDS.find(([pattern]) => pattern.test(command))?.[1] ?? 'other';
        } else if (line.startsWith('n')) {
            const match = /:(\d+)$/.exec(line.slice(1));
            const port = match ? Number(match[1]) : NaN;
            if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.has(port)) ports.set(port, kind);
        }
        if (ports.size >= MAX_PORTS) break;
    }
    return [...ports].map(([port, processKind]) => ({ port, kind: processKind }));
}

/** gh prints "Logged in to github.com account LOGIN" (older: "as LOGIN"). Anything else stays inside. */
export function parseGhAccount(output: string): string | null {
    const match = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]{1,39})\b/.exec(output);
    return match ? match[1] : null;
}

/** execFile without a shell. Resolves with the exit code; rejects only when the program cannot start. */
export const runFileWithoutShell: MetadataDeps['runFile'] = (command, args, options) => new Promise((resolve, reject) => {
    execFile(command, args, {
        cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') { reject(error); return; }
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
});

/** GET http://127.0.0.1:<port>/ with a short timeout; the body is discarded. */
export const probeLocalHttp: MetadataDeps['probeHttp'] = (port) => new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
});
