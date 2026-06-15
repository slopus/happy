import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
    chooseTerminalBackend,
    type TerminalBackendAvailability,
    type TerminalExit,
    type TerminalSpawnOptions,
    type TerminalTransport,
} from './terminalTransport';
import { PtyTerminalTransport } from './ptyTerminalTransport';
import { TmuxTerminalTransport } from './tmuxTerminalTransport';

const nodePtyMock = vi.hoisted(() => ({
    spawn: vi.fn(),
}));

vi.mock('node-pty', () => nodePtyMock);

const requireForTest = createRequire(import.meta.url);

beforeEach(() => {
    nodePtyMock.spawn.mockReset();
});

const tempLaunchScriptDirs = new Set<string>();

afterEach(async () => {
    await Promise.all(Array.from(tempLaunchScriptDirs, (dir) => rm(dir, { recursive: true, force: true })));
    tempLaunchScriptDirs.clear();
});

const requiredSpawnOptions: TerminalSpawnOptions = {
    command: 'claude',
    args: [],
    cwd: '/tmp',
    env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude',
    },
    windowName: 'claude',
};
type IsRequired<T, K extends keyof T> = Record<string, never> extends Pick<T, K> ? false : true;
const windowNameIsRequired: IsRequired<TerminalSpawnOptions, 'windowName'> = true;
const strictEnvContract: Record<string, string> = requiredSpawnOptions.env;
const terminalExit: TerminalExit = { code: 0, signal: null };
const availability: TerminalBackendAvailability = {
    tmuxConfigured: true,
    tmuxAvailable: true,
    ptyAvailable: true,
};
const contractTransport: TerminalTransport = {
    backend: 'pty',
    capabilities: ['remote-control'],
    terminalId: null,
    async spawn() {
        return { pid: 123, terminalId: 'pty:123' };
    },
    async paste() { },
    async enter() { },
    async interrupt() { },
    async resize() { },
    onData() {
        return () => { };
    },
    onExit() {
        return () => { };
    },
    dispose() { },
};

describe('chooseTerminalBackend', () => {
    it('prefers configured and available tmux over pty', () => {
        expect(chooseTerminalBackend({
            tmuxConfigured: true,
            tmuxAvailable: true,
            ptyAvailable: true,
        })).toBe('tmux');
    });

    it('falls back to pty when tmux is unavailable', () => {
        expect(chooseTerminalBackend({
            tmuxConfigured: true,
            tmuxAvailable: false,
            ptyAvailable: true,
        })).toBe('pty');
    });

    it('falls back to pty when tmux is available but no session is configured', () => {
        expect(chooseTerminalBackend({
            tmuxConfigured: false,
            tmuxAvailable: true,
            ptyAvailable: true,
        })).toBe('pty');
    });

    it('reports unsupported when neither backend can run', () => {
        expect(chooseTerminalBackend({
            tmuxConfigured: true,
            tmuxAvailable: false,
            ptyAvailable: false,
        })).toBe('unsupported');
    });

    it('accepts the flat availability contract', () => {
        expect(chooseTerminalBackend(availability)).toBe('tmux');
    });
});

describe('terminal transport capabilities', () => {
    it('exposes tmux backend capabilities', () => {
        const transport = new TmuxTerminalTransport('happy-test');

        expect(transport.backend).toBe('tmux');
        expect(transport.capabilities).toEqual(['remote-control', 'local-attach']);
        expect(transport.terminalId).toBeNull();
    });

    it('exposes pty backend capabilities', () => {
        const transport = new PtyTerminalTransport();

        expect(transport.backend).toBe('pty');
        expect(transport.capabilities).toEqual(['remote-control']);
        expect(transport.terminalId).toBeNull();
    });

    it('matches the compile-time TerminalTransport contract', async () => {
        await expect(contractTransport.spawn(requiredSpawnOptions)).resolves.toEqual({
            pid: 123,
            terminalId: 'pty:123',
        });
        expect(windowNameIsRequired).toBe(true);
        expect(strictEnvContract).toEqual({ CLAUDE_CONFIG_DIR: '/tmp/claude' });
        expect(terminalExit).toEqual({ code: 0, signal: null });
    });
});

describe('TmuxTerminalTransport', () => {
    it('returns the tmux pid and terminal id from spawn', async () => {
        const tmux = {
            spawnInTmux: vi.fn(async () => ({ success: true, sessionId: 'happy:claude', pid: 456 })),
            isPaneAlive: vi.fn(async () => true),
            capturePaneText: vi.fn(async () => ''),
            killWindow: vi.fn(async () => true),
        };
        const transport = new TmuxTerminalTransport('happy-test', tmux as any);

        const result = await transport.spawn(requiredSpawnOptions);

        expect(result).toEqual({ pid: 456, terminalId: 'happy:claude' });
        expect(transport.terminalId).toBe('happy:claude');
        const scriptPath = expectTmuxLaunchScriptCommand(tmux.spawnInTmux.mock.calls[0], {
            cwd: '/tmp',
            sessionName: 'happy-test',
            windowName: 'claude',
        });
        const script = await readFile(scriptPath, 'utf8');
        expect(script).toContain('CLAUDE_CONFIG_DIR=/tmp/claude');
        expect(script).toContain('exec env -i');
        expect(script).toContain('claude');
        await transport.dispose();
    });

    it('runs the tmux pane command through a temp script without putting Claude env in tmux argv', async () => {
        const tmux = {
            spawnInTmux: vi.fn(async () => ({ success: true, sessionId: 'happy:claude', pid: 457 })),
            isPaneAlive: vi.fn(async () => true),
            capturePaneText: vi.fn(async () => ''),
            killWindow: vi.fn(async () => true),
        };
        const transport = new TmuxTerminalTransport('happy-test', tmux as any);

        await transport.spawn({
            ...requiredSpawnOptions,
            env: {
                ALL_PROXY: 'socks://proxy.example',
                ANTHROPIC_API_KEY: 'anthropic-key',
                ANTHROPIC_BASE_URL: 'https://anthropic.example',
                API_TIMEOUT_MS: '60000',
                AUTHORIZATION: 'Bearer secret',
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
                CLAUDE_CONFIG_DIR: '/tmp/claude',
                COLORTERM: 'truecolor',
                COOKIE: 'session=secret',
                CUSTOM_KEY: 'custom-key',
                CUSTOM_SECRET: 'custom-secret',
                GITHUB_TOKEN: 'github-token',
                HAPPY_CLAUDE_PATH: '/opt/claude/bin/claude',
                HAPPY_FORKED_FROM_SESSION_ID: 'fork-session',
                HAPPY_RECONNECT_ENCRYPTION_KEY: 'reconnect-key',
                HAPPY_SERVER_URL: 'https://happy.example',
                HOME: '/Users/devdvlive',
                HTTP_PROXY: 'http://proxy.example',
                HTTPS_PROXY: 'https://secure-proxy.example',
                LANG: 'en_US.UTF-8',
                LC_ALL: 'en_US.UTF-8',
                LOGNAME: 'devdvlive',
                MCP_CONNECTION_NONBLOCKING: '1',
                NO_PROXY: 'localhost,127.0.0.1',
                NODE_EXTRA_CA_CERTS: '/tmp/certs.pem',
                PASSWORD: 'password',
                PATH: '/opt/bin:/usr/bin',
                SHELL: '/bin/zsh',
                SSH_AUTH_SOCK: '/tmp/ssh.sock',
                SSL_CERT_DIR: '/tmp/certs',
                SSL_CERT_FILE: '/tmp/cert.pem',
                TERM: 'xterm-256color',
                TMPDIR: '/tmp',
                USER: 'devdvlive',
                all_proxy: 'socks://lower-proxy.example',
                http_proxy: 'http://lower-proxy.example',
                https_proxy: 'https://lower-secure-proxy.example',
                no_proxy: 'localhost',
            },
        });

        const scriptPath = expectTmuxLaunchScriptCommand(tmux.spawnInTmux.mock.calls[0], {
            cwd: '/tmp',
            sessionName: 'happy-test',
            windowName: 'claude',
        });
        const command = (tmux.spawnInTmux.mock.calls[0] as unknown as [string[], unknown])[0];
        const tmuxArgv = command.join(' ');
        expect(tmuxArgv).not.toContain('ALL_PROXY');
        expect(tmuxArgv).not.toContain('ANTHROPIC_API_KEY');
        expect(tmuxArgv).not.toContain('anthropic-key');
        expect(tmuxArgv).not.toContain('ANTHROPIC_BASE_URL');
        expect(tmuxArgv).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
        expect(tmuxArgv).not.toContain('oauth-token');
        expect(tmuxArgv).not.toContain('CLAUDE_CONFIG_DIR');
        expect(tmuxArgv).not.toContain('HAPPY_CLAUDE_PATH');
        expect(tmuxArgv).not.toContain('MCP_CONNECTION_NONBLOCKING');
        expect(tmuxArgv).not.toContain('PATH=/opt/bin:/usr/bin');

        const script = await readFile(scriptPath, 'utf8');
        expect(script).toContain('exec env -i');
        expect(script).toContain('ALL_PROXY=socks://proxy.example');
        expect(script).toContain('ANTHROPIC_API_KEY=anthropic-key');
        expect(script).toContain('ANTHROPIC_BASE_URL=https://anthropic.example');
        expect(script).toContain('CLAUDE_CODE_OAUTH_TOKEN=oauth-token');
        expect(script).toContain('CLAUDE_CONFIG_DIR=/tmp/claude');
        expect(script).toContain('HAPPY_CLAUDE_PATH=/opt/claude/bin/claude');
        expect(script).toContain('MCP_CONNECTION_NONBLOCKING=1');
        expect(script).toContain('PATH=/opt/bin:/usr/bin');
        expect(script).toContain('claude');
        expect(script).not.toContain('AUTHORIZATION=');
        expect(script).not.toContain('COOKIE=');
        expect(script).not.toContain('CUSTOM_KEY=');
        expect(script).not.toContain('CUSTOM_SECRET=');
        expect(script).not.toContain('GITHUB_TOKEN=');
        expect(script).not.toContain('HAPPY_FORKED_FROM_SESSION_ID=');
        expect(script).not.toContain('HAPPY_RECONNECT_ENCRYPTION_KEY=');
        expect(script).not.toContain('HAPPY_SERVER_URL=');
        expect(script).not.toContain('PASSWORD=');
        await transport.dispose();
    });

    it('cleans up the temp launch script when tmux spawn fails before launch', async () => {
        const tmux = {
            spawnInTmux: vi.fn(async () => ({ success: false, error: 'tmux failed' })),
            isPaneAlive: vi.fn(async () => true),
            capturePaneText: vi.fn(async () => ''),
            killWindow: vi.fn(async () => true),
        };
        const transport = new TmuxTerminalTransport('happy-test', tmux as any);

        await expect(transport.spawn(requiredSpawnOptions)).rejects.toThrow('tmux failed');

        const scriptPath = expectTmuxLaunchScriptCommand(tmux.spawnInTmux.mock.calls[0], {
            cwd: '/tmp',
            sessionName: 'happy-test',
            windowName: 'claude',
        });
        await expect(stat(scriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('emits an exit when the tmux pane disappears during polling', async () => {
        const tmux = {
            spawnInTmux: vi.fn(async () => ({ success: true, sessionId: 'happy:claude', pid: 458 })),
            isPaneAlive: vi.fn(async () => false),
            capturePaneText: vi.fn(async () => ''),
            killWindow: vi.fn(async () => true),
        };
        const transport = new TmuxTerminalTransport('happy-test', tmux as any);
        const exits: TerminalExit[] = [];

        transport.onExit((exit) => exits.push(exit));
        await transport.spawn(requiredSpawnOptions);

        await vi.waitFor(() => {
            expect(exits).toEqual([{ code: null, signal: null }]);
        });
        expect(tmux.capturePaneText).not.toHaveBeenCalled();
        expect(transport.terminalId).toBeNull();
        await transport.dispose();
    });

    it('uses stable tmux pane and window ids for operations after spawn', async () => {
        const tmux = {
            spawnInTmux: vi.fn(async () => ({
                success: true,
                sessionId: 'happy:claude',
                pid: 459,
                windowId: '@42',
                paneId: '%7',
            })),
            isPaneAlive: vi.fn(async () => true),
            capturePaneText: vi.fn(async () => ''),
            pasteText: vi.fn(async () => true),
            sendKeys: vi.fn(async () => true),
            resizePane: vi.fn(async () => true),
            killWindow: vi.fn(async () => true),
        };
        const transport = new TmuxTerminalTransport('happy-test', tmux as any);

        await transport.spawn(requiredSpawnOptions);

        await vi.waitFor(() => {
            expect(tmux.isPaneAlive).toHaveBeenCalledWith(undefined, undefined, '%7');
            expect(tmux.capturePaneText).toHaveBeenCalledWith(undefined, undefined, '%7');
        });

        await transport.paste('hello');
        await transport.enter();
        await transport.interrupt();
        await transport.resize(120, 40);
        await transport.dispose();

        expect(tmux.pasteText).toHaveBeenCalledWith('hello', undefined, undefined, '%7');
        expect(tmux.sendKeys).toHaveBeenCalledWith('C-m', undefined, undefined, '%7');
        expect(tmux.sendKeys).toHaveBeenCalledWith('C-c', undefined, undefined, '%7');
        expect(tmux.resizePane).toHaveBeenCalledWith(120, 40, undefined, undefined, '%7');
        expect(tmux.killWindow).toHaveBeenCalledWith('@42');
    });
});

describe('PtyTerminalTransport', () => {
    it('spawns with initial 120x30 dimensions and returns pid plus terminal id', async () => {
        const ptyProcess = createMockPtyProcess({ pid: 789 });
        nodePtyMock.spawn.mockReturnValue(ptyProcess);
        const transport = new PtyTerminalTransport();

        const result = await transport.spawn(requiredSpawnOptions);

        expect(result).toEqual({ pid: 789, terminalId: 'pty:789' });
        expect(transport.terminalId).toBe('pty:789');
        expect(nodePtyMock.spawn).toHaveBeenCalledWith('claude', [], expect.objectContaining({
            cols: 120,
            rows: 30,
            cwd: '/tmp',
        }));
        transport.dispose();
    });

    it('spawns with sanitized Claude runtime env only', async () => {
        const ptyProcess = createMockPtyProcess({ pid: 791 });
        nodePtyMock.spawn.mockReturnValue(ptyProcess);
        const transport = new PtyTerminalTransport();

        await withProcessEnv({
            AUTHORIZATION: 'Bearer host-secret',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'host-reconnect-key',
            HAPPY_SERVER_URL: 'https://host-happy.example',
        }, async () => {
            await transport.spawn({
                ...requiredSpawnOptions,
                env: {
                    ANTHROPIC_API_KEY: 'anthropic-key',
                    AUTHORIZATION: 'Bearer option-secret',
                    CLAUDE_CONFIG_DIR: '/tmp/claude',
                    CUSTOM_KEY: 'custom-key',
                    HAPPY_FORKED_FROM_SESSION_ID: 'fork-session',
                    HAPPY_RECONNECT_ENCRYPTION_KEY: 'option-reconnect-key',
                    HAPPY_SERVER_URL: 'https://option-happy.example',
                    HOME: '/Users/devdvlive',
                    MCP_CONNECTION_NONBLOCKING: '1',
                    PATH: '/opt/bin:/usr/bin',
                    TERM: 'xterm-256color',
                },
            });
        });

        const ptyOptions = nodePtyMock.spawn.mock.calls[0][2];
        expect(ptyOptions.env).toEqual({
            ANTHROPIC_API_KEY: 'anthropic-key',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            HOME: '/Users/devdvlive',
            MCP_CONNECTION_NONBLOCKING: '1',
            PATH: '/opt/bin:/usr/bin',
            TERM: 'xterm-256color',
        });
        transport.dispose();
    });

    it('repairs non-executable node-pty spawn-helper before spawning', async () => {
        const helperPath = await findNodePtySpawnHelper();
        if (helperPath === null) {
            return;
        }

        const originalMode = (await stat(helperPath)).mode & 0o777;
        const nonExecutableMode = originalMode & ~0o111;
        const ptyProcess = createMockPtyProcess({ pid: 792 });
        nodePtyMock.spawn.mockReturnValue(ptyProcess);
        await chmod(helperPath, nonExecutableMode);

        try {
            const transport = new PtyTerminalTransport();

            await transport.spawn(requiredSpawnOptions);

            expect((await stat(helperPath)).mode & 0o111).not.toBe(0);
            transport.dispose();
        } finally {
            await chmod(helperPath, originalMode);
        }
    });

    it('emits terminal exits using code and signal fields', async () => {
        const ptyProcess = createMockPtyProcess({ pid: 790 });
        nodePtyMock.spawn.mockReturnValue(ptyProcess);
        const transport = new PtyTerminalTransport();
        const exits: TerminalExit[] = [];

        transport.onExit((exit) => exits.push(exit));
        await transport.spawn(requiredSpawnOptions);
        ptyProcess.emitExit({ exitCode: 130, signal: 'SIGINT' });

        expect(exits).toEqual([{ code: 130, signal: 'SIGINT' }]);
    });
});

async function findNodePtySpawnHelper(): Promise<string | null> {
    const packageRoot = dirname(dirname(requireForTest.resolve('node-pty')));
    const candidates = [
        join(packageRoot, 'build', 'Release', 'spawn-helper'),
        join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];

    for (const candidate of candidates) {
        try {
            const entry = await stat(candidate);
            if (entry.isFile()) {
                return candidate;
            }
        } catch {
            // Try the next node-pty layout.
        }
    }

    return null;
}

function expectTmuxLaunchScriptCommand(
    call: unknown[],
    options: { cwd: string; sessionName: string; windowName: string },
): string {
    expect(call).toHaveLength(2);
    const [command, spawnOptions] = call as [string[], unknown];
    expect(command).toHaveLength(2);
    expect(command[0]).toBe('/bin/sh');
    const scriptPath = unquoteShellArg(command[1]);
    expect(scriptPath).toMatch(/launch\.sh$/);
    expect(spawnOptions).toEqual(expect.objectContaining(options));
    tempLaunchScriptDirs.add(dirname(scriptPath));
    return scriptPath;
}

function unquoteShellArg(value: string): string {
    if (!value.startsWith("'") || !value.endsWith("'")) {
        return value;
    }
    return value.slice(1, -1).replace(/'\\''/g, "'");
}

function createMockPtyProcess({ pid }: { pid: number }) {
    let exitHandler: ((event: { exitCode: number; signal?: string }) => void) | undefined;

    return {
        pid,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn((handler: (event: { exitCode: number; signal?: string }) => void) => {
            exitHandler = handler;
            return { dispose: vi.fn() };
        }),
        emitExit(event: { exitCode: number; signal?: string }) {
            exitHandler?.(event);
        },
    };
}

async function withProcessEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(env)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
    }

    try {
        await fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}
