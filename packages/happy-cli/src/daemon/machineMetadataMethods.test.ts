/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary D4-2 — metadata the
 * server lane may read from a strict machine. Each answer has a fixed shape
 * and carries no file content, no file listing and no command output.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMachineMetadataHandlers, METADATA_METHODS, type MetadataDeps } from './machineMetadataMethods';

function setup(overrides: Partial<MetadataDeps> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'metadata-'));
    const happyHome = join(root, '.happy');
    const workspace = join(root, 'workspace', 'project');
    mkdirSync(happyHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'secret-name.txt'), 'top secret content');
    mkdirSync(join(workspace, 'src'));
    const runFile = vi.fn<MetadataDeps['runFile']>(async () => ({ code: 1, stdout: '', stderr: '' }));
    const deps: MetadataDeps = {
        allowedRoot: root, happyHomeDir: happyHome, platform: 'linux', cliVersion: '1.2.3',
        runFile, probeHttp: async () => ({ status: 200 }), ...overrides,
    };
    return { root, happyHome, workspace, runFile, handlers: createMachineMetadataHandlers(deps) };
}

const leaks = (value: unknown, ...needles: string[]) => needles.some((needle) => JSON.stringify(value).includes(needle));

describe('machine metadata methods', () => {
    it('defines exactly the seven D4-2 methods', () => {
        expect([...METADATA_METHODS].sort()).toEqual([
            'container-runtime-status', 'gh-auth-status', 'listening-ports', 'machine-info',
            'preview-liveness', 'workspace-git-info', 'workspace-path-stat',
        ]);
    });

    describe('workspace-path-stat', () => {
        it('answers existence, kind and entry count without naming any entry', async () => {
            const { handlers, workspace } = setup();
            const result = await handlers['workspace-path-stat']({ workspaceRoot: workspace, path: workspace });
            expect(result).toEqual({ success: true, exists: true, isDirectory: true, entryCount: 2 });
            expect(leaks(result, 'secret-name', 'top secret', 'src')).toBe(false);
        });

        it('reports a missing path inside the workspace as absent', async () => {
            const { handlers, workspace } = setup();
            expect(await handlers['workspace-path-stat']({ workspaceRoot: workspace, path: join(workspace, 'nope') }))
                .toEqual({ success: true, exists: false, isDirectory: false, entryCount: null });
        });

        it('refuses a path outside the workspace or inside the happy home', async () => {
            const { handlers, workspace, happyHome, root } = setup();
            const outside = await handlers['workspace-path-stat']({ workspaceRoot: workspace, path: root });
            expect(outside).toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
            const home = await handlers['workspace-path-stat']({ workspaceRoot: happyHome, path: happyHome });
            expect(home).toMatchObject({ success: false, errorCode: 'WORKSPACE_PATH_DENIED' });
        });
    });

    describe('workspace-git-info', () => {
        it('returns branch names and a change count, never changed file names', async () => {
            const runFile = vi.fn<MetadataDeps['runFile']>(async (_cmd, args) => {
                const sub = args.slice(args.indexOf('-C') + 2);
                if (sub[0] === 'rev-parse') return { code: 0, stdout: 'true\n', stderr: '' };
                if (sub[0] === 'branch') return { code: 0, stdout: 'main\n', stderr: '' };
                if (sub[0] === 'for-each-ref') return { code: 0, stdout: 'main\nfeature/x\n', stderr: '' };
                if (sub[0] === 'status') return { code: 0, stdout: ' M secret-name.txt\0?? src/new.ts\0', stderr: '' };
                return { code: 1, stdout: '', stderr: '' };
            });
            const { handlers, workspace } = setup({ runFile });
            const result = await handlers['workspace-git-info']({ workspaceRoot: workspace, path: workspace });
            expect(result).toEqual({ success: true, isGitRepo: true, branch: 'main', localBranches: ['main', 'feature/x'], changedCount: 2 });
            expect(leaks(result, 'secret-name', 'new.ts')).toBe(false);
        });

        it('runs git without repository-configured commands or prompts', async () => {
            const { handlers, workspace, runFile } = setup();
            await handlers['workspace-git-info']({ workspaceRoot: workspace, path: workspace });
            const [cmd, args, options] = runFile.mock.calls[0];
            expect(cmd).toBe('git');
            expect(args).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']));
            expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
        });

        it('answers a folder that is not a repository', async () => {
            const { handlers, workspace } = setup();
            expect(await handlers['workspace-git-info']({ workspaceRoot: workspace, path: workspace }))
                .toEqual({ success: true, isGitRepo: false, branch: null, localBranches: [], changedCount: 0 });
        });
    });

    describe('preview-liveness', () => {
        it('reports whether a local port answers, without the body', async () => {
            const probeHttp = vi.fn(async () => ({ status: 200 }));
            const { handlers } = setup({ probeHttp });
            expect(await handlers['preview-liveness']({ port: 5173 })).toEqual({ success: true, up: true, statusCode: 200 });
            expect(probeHttp).toHaveBeenCalledWith(5173);
        });

        it('rejects a port that is not a TCP port number', async () => {
            const { handlers } = setup();
            expect(await handlers['preview-liveness']({ port: 0 })).toMatchObject({ success: false, errorCode: 'INVALID_PARAMS' });
            expect(await handlers['preview-liveness']({ port: '80; id' })).toMatchObject({ success: false, errorCode: 'INVALID_PARAMS' });
        });
    });

    describe('listening-ports', () => {
        it('returns ports and a coarse process kind, not process ids or command lines', async () => {
            const runFile = vi.fn<MetadataDeps['runFile']>(async () => ({
                code: 0, stderr: '',
                stdout: 'p101\ncnode\nn*:5173\np202\ncpython3.11\nn127.0.0.1:8000\np303\ncsecretd\nn[::]:9999\n',
            }));
            const { handlers } = setup({ runFile });
            const result = await handlers['listening-ports']({});
            expect(result).toEqual({ success: true, ports: [
                { port: 5173, kind: 'node' }, { port: 8000, kind: 'python' }, { port: 9999, kind: 'other' },
            ] });
            expect(leaks(result, '101', 'secretd', 'python3.11')).toBe(false);
        });
    });

    describe('container-runtime-status', () => {
        it('answers only whether docker is usable', async () => {
            const runFile = vi.fn<MetadataDeps['runFile']>(async () => ({ code: 0, stdout: '27.1.1\n', stderr: '' }));
            const { handlers } = setup({ runFile });
            expect(await handlers['container-runtime-status']({})).toEqual({ success: true, available: true });
        });
    });

    describe('gh-auth-status', () => {
        it('returns the login and never the token line', async () => {
            const runFile = vi.fn<MetadataDeps['runFile']>(async () => ({
                code: 0, stdout: '',
                stderr: 'github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Token: gho_************************************\n  - Token scopes: repo\n',
            }));
            const { handlers } = setup({ runFile });
            const result = await handlers['gh-auth-status']({});
            expect(result).toEqual({ success: true, installed: true, loggedIn: true, account: 'octo-cat' });
            expect(leaks(result, 'gho_', 'scopes')).toBe(false);
        });

        it('reports gh missing or logged out', async () => {
            const missing = setup({ runFile: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } });
            expect(await missing.handlers['gh-auth-status']({})).toEqual({ success: true, installed: false, loggedIn: false, account: null });
            const out = setup({ runFile: async () => ({ code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }) });
            expect(await out.handlers['gh-auth-status']({})).toEqual({ success: true, installed: true, loggedIn: false, account: null });
        });
    });

    it('machine-info answers platform and CLI version', async () => {
        const { handlers } = setup();
        expect(await handlers['machine-info']({})).toEqual({ success: true, platform: 'linux', cliVersion: '1.2.3' });
    });
});
