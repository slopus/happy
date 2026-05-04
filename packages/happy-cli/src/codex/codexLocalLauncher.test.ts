import { describe, expect, it } from 'vitest';

import { buildCodexNativeArgs, launchNativeCodex } from './codexLocalLauncher';

describe('buildCodexNativeArgs', () => {
    it('builds a fresh native Codex launch with startup defaults', () => {
        expect(buildCodexNativeArgs({
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
        })).toEqual([
            '--model',
            'gpt-5.5',
            '-c',
            'model_reasoning_effort="medium"',
            '--dangerously-bypass-approvals-and-sandbox',
        ]);
    });

    it('uses positional resume syntax when a Codex thread id is known', () => {
        expect(buildCodexNativeArgs({
            codexThreadId: 'thread-123',
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
        })).toEqual([
            'resume',
            'thread-123',
            '--model',
            'gpt-5.5',
            '-c',
            'model_reasoning_effort="medium"',
            '--dangerously-bypass-approvals-and-sandbox',
        ]);
    });

    it('maps read-only permission mode to native approval and sandbox flags', () => {
        expect(buildCodexNativeArgs({
            permissionMode: 'read-only',
        })).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'read-only',
        ]);
    });

    it('maps safe-yolo permission mode to native approval and workspace sandbox flags', () => {
        expect(buildCodexNativeArgs({
            permissionMode: 'safe-yolo',
        })).toEqual([
            '--ask-for-approval',
            'on-failure',
            '--sandbox',
            'workspace-write',
        ]);
    });
});

describe('launchNativeCodex', () => {
    it('spawns native Codex with inherited stdio', async () => {
        const spawnCalls: unknown[] = [];

        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
            spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
                spawnCalls.push({ command, args, options });
                return {
                    once: (event: string, callback: (value: unknown) => void) => {
                        if (event === 'exit') {
                            callback(0);
                        }
                        return undefined;
                    },
                };
            }) as never,
        });

        expect(result).toEqual({ type: 'exit', code: 0 });
        expect(spawnCalls).toEqual([{
            command: 'codex',
            args: [
                '--model',
                'gpt-5.5',
                '-c',
                'model_reasoning_effort="medium"',
                '--dangerously-bypass-approvals-and-sandbox',
            ],
            options: expect.objectContaining({
                cwd: '/tmp/project',
                stdio: 'inherit',
            }),
        }]);
    });
});
