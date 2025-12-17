import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claudeLocal } from './claudeLocal';

// Mock dependencies - use vi.hoisted to ensure mocks are available at hoist time
const { mockSpawn, mockClaudeFindLastSession } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockClaudeFindLastSession: vi.fn()
}));

vi.mock('node:child_process', () => ({
    spawn: mockSpawn
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
    existsSync: vi.fn(() => true)
}));

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: vi.fn(() => true) // Always return true (session exists)
}));

describe('claudeLocal --continue handling', () => {
    let onSessionFound: any;

    beforeEach(() => {
        // Mock spawn to resolve immediately
        mockSpawn.mockReturnValue({
            stdio: [null, null, null, null],
            on: vi.fn((event, callback) => {
                // Immediately call the 'exit' callback
                if (event === 'exit') {
                    process.nextTick(() => callback(0));
                }
            }),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            kill: vi.fn(),
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            stdin: {
                on: vi.fn(),
                end: vi.fn()
            }
        });

        onSessionFound = vi.fn();

        // Reset mocks
        vi.clearAllMocks();
    });

    it('should convert --continue to --resume with last session ID', async () => {
        // Mock claudeFindLastSession to return a session ID
        mockClaudeFindLastSession.mockReturnValue('123e4567-e89b-12d3-a456-426614174000');

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue'] // User wants to continue last session
        });

        // Verify spawn was called
        expect(mockSpawn).toHaveBeenCalled();

        // Get the args passed to spawn (second argument is the array)
        const spawnArgs = mockSpawn.mock.calls[0][1];

        // Should NOT contain --continue (converted to --resume)
        expect(spawnArgs).not.toContain('--continue');

        // Should NOT contain --session-id (no conflict)
        expect(spawnArgs).not.toContain('--session-id');

        // Should contain --resume with the found session ID
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('123e4567-e89b-12d3-a456-426614174000');

        // Should notify about the session
        expect(onSessionFound).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000');
    });

    it('should create new session when --continue but no sessions exist', async () => {
        // Mock claudeFindLastSession to return null (no sessions)
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue']
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];

        // Should contain --session-id for new session
        expect(spawnArgs).toContain('--session-id');

        // Should not contain --resume or --continue
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
            claudeArgs: [] // No session flags - new session
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];
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
            claudeArgs: [] // No --continue
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];
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

        // claudeArgs should be modified to remove --continue
        expect(claudeArgs).not.toContain('--continue');
        expect(claudeArgs).toContain('--other-flag');
    });
});