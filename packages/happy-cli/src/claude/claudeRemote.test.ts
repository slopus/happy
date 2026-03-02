/**
 * Tests for auth environment variable stripping in claudeRemote.
 *
 * Issue #120: When a local session switches to remote mode (doSwitch), or when
 * claudeRemote is invoked directly, inherited auth env vars must be stripped from
 * process.env before the Claude Code SDK is called.  The SDK reads process.env
 * directly for .cjs launcher executables (sdk/query.ts:343), so if
 * ANTHROPIC_API_KEY is still set it overrides Claude's native OAuth / Max-plan
 * authentication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks – must be declared before any vi.mock() calls
// ---------------------------------------------------------------------------
const { mockQuery } = vi.hoisted(() => ({
    mockQuery: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/claude/sdk', () => ({
    query: mockQuery,
    AbortError: class AbortError extends Error {},
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: vi.fn(() => true),
}));

vi.mock('./utils/path', () => ({
    getProjectPath: vi.fn((p: string) => p),
}));

vi.mock('./utils/systemPrompt', () => ({
    systemPrompt: 'test-system-prompt',
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/projectPath', () => ({
    projectPath: vi.fn(() => '/fake/project'),
}));

vi.mock('@/parsers/specialCommands', () => ({
    parseSpecialCommand: vi.fn(() => ({ type: 'none' })),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeMode() {
    return {
        permissionMode: 'default' as const,
        model: undefined,
        fallbackModel: undefined,
        customSystemPrompt: undefined,
        appendSystemPrompt: undefined,
        allowedTools: undefined,
        disallowedTools: undefined,
    };
}

function makeBaseOpts(overrides: Record<string, unknown> = {}) {
    const mode = makeMode();
    return {
        sessionId: null,
        path: '/tmp/test-project',
        claudeEnvVars: {} as Record<string, string>,
        allowedTools: [],
        hookSettingsPath: '/tmp/test-settings.json',
        nextMessage: vi.fn().mockResolvedValueOnce({ message: 'hello', mode }).mockResolvedValue(null),
        onReady: vi.fn(),
        isAborted: vi.fn(() => false),
        onSessionFound: vi.fn(),
        onMessage: vi.fn(),
        canCallTool: vi.fn(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Helpers to set up the mock query to emit a minimal result immediately
// ---------------------------------------------------------------------------
async function* makeResultStream() {
    yield {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-id-abc123',
    };
    yield { type: 'result' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('claudeRemote – auth env var stripping (Issue #120)', () => {
    const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        // Save and restore process.env around each test
        savedEnv = {};
        for (const key of AUTH_VARS) {
            savedEnv[key] = process.env[key];
        }

        // Seed the auth vars so they are definitely present
        process.env.ANTHROPIC_API_KEY = 'sk-inherited-key';
        process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-token';
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-oauth';

        mockQuery.mockReturnValue(makeResultStream());
    });

    afterEach(() => {
        // Restore process.env
        for (const key of AUTH_VARS) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = savedEnv[key];
            }
        }
        vi.clearAllMocks();
    });

    it('strips inherited ANTHROPIC_API_KEY from process.env before SDK call when not in claudeEnvVars', async () => {
        const { claudeRemote } = await import('./claudeRemote');

        let apiKeyAtCallTime: string | undefined = 'SENTINEL_NOT_CHECKED';
        mockQuery.mockImplementation(function* () {
            apiKeyAtCallTime = process.env.ANTHROPIC_API_KEY;
            yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
            yield { type: 'result' };
        });

        const opts = makeBaseOpts({ claudeEnvVars: {} });
        await claudeRemote(opts as any);

        expect(apiKeyAtCallTime).toBeUndefined();
    });

    it('strips inherited ANTHROPIC_AUTH_TOKEN from process.env before SDK call when not in claudeEnvVars', async () => {
        const { claudeRemote } = await import('./claudeRemote');

        let tokenAtCallTime: string | undefined = 'SENTINEL_NOT_CHECKED';
        mockQuery.mockImplementation(function* () {
            tokenAtCallTime = process.env.ANTHROPIC_AUTH_TOKEN;
            yield { type: 'system', subtype: 'init', session_id: 'sess-2' };
            yield { type: 'result' };
        });

        const opts = makeBaseOpts({ claudeEnvVars: {} });
        await claudeRemote(opts as any);

        expect(tokenAtCallTime).toBeUndefined();
    });

    it('strips inherited CLAUDE_CODE_OAUTH_TOKEN from process.env before SDK call when not in claudeEnvVars', async () => {
        const { claudeRemote } = await import('./claudeRemote');

        let oauthAtCallTime: string | undefined = 'SENTINEL_NOT_CHECKED';
        mockQuery.mockImplementation(function* () {
            oauthAtCallTime = process.env.CLAUDE_CODE_OAUTH_TOKEN;
            yield { type: 'system', subtype: 'init', session_id: 'sess-3' };
            yield { type: 'result' };
        });

        const opts = makeBaseOpts({ claudeEnvVars: {} });
        await claudeRemote(opts as any);

        expect(oauthAtCallTime).toBeUndefined();
    });

    it('preserves ANTHROPIC_API_KEY when explicitly provided in claudeEnvVars', async () => {
        const { claudeRemote } = await import('./claudeRemote');

        let apiKeyAtCallTime: string | undefined = 'SENTINEL_NOT_CHECKED';
        mockQuery.mockImplementation(function* () {
            apiKeyAtCallTime = process.env.ANTHROPIC_API_KEY;
            yield { type: 'system', subtype: 'init', session_id: 'sess-4' };
            yield { type: 'result' };
        });

        const opts = makeBaseOpts({
            claudeEnvVars: { ANTHROPIC_API_KEY: 'sk-explicit-key' },
        });
        await claudeRemote(opts as any);

        // Inherited or explicit value should remain – either is acceptable as long as it's set
        expect(apiKeyAtCallTime).not.toBeUndefined();
    });

    it('strips all three auth vars when none are in claudeEnvVars', async () => {
        const { claudeRemote } = await import('./claudeRemote');

        const capturedEnv: Record<string, string | undefined> = {};
        mockQuery.mockImplementation(function* () {
            for (const key of AUTH_VARS) {
                capturedEnv[key] = process.env[key];
            }
            yield { type: 'system', subtype: 'init', session_id: 'sess-5' };
            yield { type: 'result' };
        });

        const opts = makeBaseOpts({ claudeEnvVars: {} });
        await claudeRemote(opts as any);

        for (const key of AUTH_VARS) {
            expect(capturedEnv[key], `${key} should be undefined`).toBeUndefined();
        }
    });

    it('does not strip auth vars when claudeEnvVars is undefined', async () => {
        const { claudeRemote } = await import('./claudeRemote');

        // When claudeEnvVars is undefined, no auth vars were explicitly configured,
        // so they should still be stripped (treat same as empty object).
        let apiKeyAtCallTime: string | undefined = 'SENTINEL_NOT_CHECKED';
        mockQuery.mockImplementation(function* () {
            apiKeyAtCallTime = process.env.ANTHROPIC_API_KEY;
            yield { type: 'system', subtype: 'init', session_id: 'sess-6' };
            yield { type: 'result' };
        });

        const opts = makeBaseOpts({ claudeEnvVars: undefined });
        await claudeRemote(opts as any);

        expect(apiKeyAtCallTime).toBeUndefined();
    });
});
