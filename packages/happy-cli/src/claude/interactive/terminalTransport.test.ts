import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
    nodePtyMock.spawn.mockReset();
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

    it('falls back to pty when tmux is not configured', () => {
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
        expect(tmux.spawnInTmux).toHaveBeenCalledWith(
            ['claude'],
            {
                cwd: '/tmp',
                sessionName: 'happy-test',
                windowName: 'claude',
            },
            {},
        );
        await transport.dispose();
    });

    it('filters sensitive and path-like environment before spawning in tmux', async () => {
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
                ANTHROPIC_API_KEY: 'secret-key',
                AUTHORIZATION: 'Bearer secret',
                CLAUDE_CONFIG_DIR: '/tmp/claude',
                COOKIE: 'session=secret',
                HOME: '/Users/devdvlive',
                NO_PROXY: 'localhost,127.0.0.1',
                PATH: '/opt/secret/bin',
                PASSWORD: 'password',
                no_proxy: 'localhost',
            },
        });

        expect(tmux.spawnInTmux).toHaveBeenCalledWith(
            ['claude'],
            expect.objectContaining({
                cwd: '/tmp',
                sessionName: 'happy-test',
                windowName: 'claude',
            }),
            {
                NO_PROXY: 'localhost,127.0.0.1',
                no_proxy: 'localhost',
            },
        );
        await transport.dispose();
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
