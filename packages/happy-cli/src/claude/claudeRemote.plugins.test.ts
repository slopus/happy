import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemote } from './claudeRemote';
import { Session } from './session';

// Keep the real Happy query adapter: assertions must reach the official SDK boundary.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));
vi.mock('@/lib', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('./utils/systemPrompt', () => ({ systemPrompt: 'fixture system prompt' }));

const cwd = resolve('fixture session');
const sessionId = '11111111-2222-4333-8444-555555555555';

async function start(claudeArgs?: string[], resume: string | null = null) {
    const canCallTool = vi.fn(async () => ({ behavior: 'deny' as const, message: 'fixture deny' }));
    await claudeRemote({
        path: cwd,
        sessionId: resume,
        claudeArgs,
        allowedTools: ['Read'],
        hookSettingsPath: resolve(cwd, 'happy-settings.json'),
        nextMessage: async () => ({ message: 'fixture message', mode: { permissionMode: 'default' } }),
        canCallTool,
        isAborted: () => false,
        onReady: vi.fn(),
        onSessionFound: vi.fn(),
        onMessage: vi.fn(),
    });
    return canCallTool;
}

describe('remote plugin forwarding to the Claude Agent SDK', () => {
    beforeEach(() => {
        vi.mocked(sdkQuery).mockReset();
        vi.mocked(sdkQuery).mockReturnValue({
            async *[Symbol.asyncIterator]() {},
        } as ReturnType<typeof sdkQuery>);
    });

    it('forwards repeated separated/equal paths relative to session cwd without mutating args', async () => {
        const absolute = resolve('absolute plugin');
        const args = ['--plugin-dir', './my plugin', `--plugin-dir=${absolute}`, '--plugin-dir=../other=plugin'];
        const original = [...args];
        await start(args);
        expect(sdkQuery).toHaveBeenCalledOnce();
        expect(vi.mocked(sdkQuery).mock.calls[0][0].options?.plugins).toEqual([
            { type: 'local', path: resolve(cwd, 'my plugin') },
            { type: 'local', path: absolute },
            { type: 'local', path: resolve(cwd, '../other=plugin') },
        ]);
        expect(args).toEqual(original);
    });

    it.each([
        { args: undefined },
        { args: [] },
        { args: ['--model', 'example'] },
        { args: ['--', '--plugin-dir', './not-a-flag'] },
    ])(
        'does not supply plugins without an explicit option: $args', async ({ args }) => {
            await start(args);
            expect(vi.mocked(sdkQuery).mock.calls[0][0].options?.plugins).toBeUndefined();
        },
    );

    it.each([
        ['--plugin-dir'],
        ['--plugin-dir', '--dangerously-skip-permissions'],
        ['--plugin-dir', ''],
        ['--plugin-dir='],
        ['--plugin-dir=bad\0path'],
    ])('rejects malformed plugin args before calling the SDK: %j', async (...args) => {
        await expect(start(args)).rejects.toThrow('--plugin-dir requires');
        expect(sdkQuery).not.toHaveBeenCalled();
    });

    it('keeps plugin arguments on resume and after local startup consumes one-time flags', async () => {
        const session = new Session({
            path: cwd,
            logPath: '',
            sessionId,
            claudeArgs: ['--resume', sessionId, '--plugin-dir', './my plugin', '--continue'],
            api: {} as Session['api'],
            client: { keepAlive: vi.fn() } as unknown as Session['client'],
            messageQueue: {} as Session['queue'],
            mcpServers: {},
            hookSettingsPath: '',
            onModeChange: vi.fn(),
        });
        try {
            await start(session.claudeArgs);
            session.consumeOneTimeFlags();
            await start(session.claudeArgs, session.sessionId);
            expect(sdkQuery).toHaveBeenCalledTimes(2);
            for (const [request] of vi.mocked(sdkQuery).mock.calls) {
                expect(request.options).toMatchObject({
                    resume: sessionId,
                    plugins: [{ type: 'local', path: resolve(cwd, 'my plugin') }],
                });
            }
        } finally {
            session.cleanup();
        }
    });

    it('treats shell/flag-shaped text as paths and preserves permission/settings boundaries', async () => {
        const path = '--dangerously-skip-permissions;$(touch SHOULD_NOT_EXIST)';
        const canCallTool = await start([
            `--plugin-dir=${path}`,
            '--dangerously-skip-permissions', '--settings', 'untrusted.json',
        ]);
        const options = vi.mocked(sdkQuery).mock.calls[0][0].options!;
        expect(options).toMatchObject({
            cwd,
            plugins: [{ type: 'local', path: resolve(cwd, path) }],
            permissionMode: 'default',
            settings: resolve(cwd, 'happy-settings.json'),
            allowedTools: ['Read'],
        });
        expect(options.extraArgs).toBeUndefined();
        expect(options.allowDangerouslySkipPermissions).toBeUndefined();
        const toolOptions = { signal: new AbortController().signal, toolUseID: 'fixture-tool', requestId: 'fixture-request' };
        await expect(options.canUseTool!('Bash', {}, toolOptions)).resolves.toEqual({
            behavior: 'deny', message: 'fixture deny',
        });
        expect(canCallTool).toHaveBeenCalledWith('Bash', {}, { permissionMode: 'default' }, toolOptions);
    });
});