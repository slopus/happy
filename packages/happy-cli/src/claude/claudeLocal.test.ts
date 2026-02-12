import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claudeLocal } from './claudeLocal';

const { mockPtySpawn, mockClaudeFindLastSession, mockNetCreateServer } = vi.hoisted(() => ({
    mockPtySpawn: vi.fn(),
    mockClaudeFindLastSession: vi.fn(),
    mockNetCreateServer: vi.fn(),
}));

vi.mock('node-pty', () => ({
    default: { spawn: mockPtySpawn },
    spawn: mockPtySpawn,
}));

vi.mock('node:net', () => ({
    createServer: mockNetCreateServer,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('./utils/claudeFindLastSession', () => ({
    claudeFindLastSession: mockClaudeFindLastSession
}));

vi.mock('./utils/path', () => ({
    getProjectPath: vi.fn((path: string) => path)
}));

vi.mock('./utils/systemPrompt', () => ({
    systemPrompt: 'test-system-prompt'
}));

vi.mock('node:fs', () => ({
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    unlinkSync: vi.fn(),
}));

describe('claudeLocal --continue handling', () => {
    let onSessionFound: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Mock PTY spawn to return a process that exits cleanly on next tick
        mockPtySpawn.mockImplementation(() => ({
            pid: 12345,
            onData: vi.fn(),
            onExit: vi.fn((cb: Function) => {
                process.nextTick(() => cb({ exitCode: 0, signal: 0 }));
            }),
            write: vi.fn(),
            resize: vi.fn(),
            kill: vi.fn(),
        }));

        // Mock net.createServer for IPC socket
        mockNetCreateServer.mockImplementation(() => ({
            listen: vi.fn((_path: string, cb: Function) => cb()),
            close: vi.fn(),
            on: vi.fn(),
        }));

        onSessionFound = vi.fn();
    });

    it('should convert --continue to --resume with last session ID', async () => {
        mockClaudeFindLastSession.mockReturnValue('123e4567-e89b-12d3-a456-426614174000');

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue']
        });

        expect(mockPtySpawn).toHaveBeenCalled();

        // pty.spawn('node', [claudeCliPath, ...args], opts) — second arg is the args array
        const spawnArgs = mockPtySpawn.mock.calls[0][1];

        expect(spawnArgs).not.toContain('--continue');
        expect(spawnArgs).not.toContain('--session-id');
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('123e4567-e89b-12d3-a456-426614174000');
        expect(onSessionFound).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000');
    });

    it('should create new session when --continue but no sessions exist', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue']
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];

        expect(spawnArgs).toContain('--session-id');
        expect(spawnArgs).not.toContain('--resume');
        expect(spawnArgs).not.toContain('--continue');
    });

    it('should add --session-id for normal new sessions without --continue', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: []
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--session-id');
        expect(spawnArgs).not.toContain('--continue');
        expect(spawnArgs).not.toContain('--resume');
    });

    it('should handle --resume with specific session ID without conflict', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: 'existing-session-123',
            path: '/tmp',
            onSessionFound,
            claudeArgs: []
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('existing-session-123');
        expect(spawnArgs).not.toContain('--session-id');
    });

    it('should remove --continue from claudeArgs after conversion', async () => {
        mockClaudeFindLastSession.mockReturnValue('session-456');

        const claudeArgs = ['--continue', '--other-flag'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];
        expect(spawnArgs).not.toContain('--continue');
        expect(spawnArgs).toContain('--other-flag');
    });

    it('should pass --resume to Claude when no session ID provided', async () => {
        const claudeArgs = ['--resume'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).not.toContain('--session-id');
    });

    it('should extract and use --resume <id> when session ID is provided', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);
        const claudeArgs = ['--resume', 'abc-123-def'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('abc-123-def');
        expect(spawnArgs).not.toContain('--session-id');
        expect(onSessionFound).toHaveBeenCalledWith('abc-123-def');
    });

    it('should handle -r short flag same as --resume', async () => {
        const claudeArgs = ['-r'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        const spawnArgs = mockPtySpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('-r');
    });
});
