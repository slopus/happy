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
            codexThreadId: 'thread-existing',
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

        expect(result).toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(spawnCalls).toEqual([{
            command: 'codex',
            args: [
                'resume',
                'thread-existing',
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

    it('returns a discovered Codex thread id for fresh local sessions', async () => {
        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            now: () => new Date('2026-05-04T11:00:00.000Z'),
            discoverThreadId: async ({ startedAt, finishedAt }) => {
                expect(startedAt).toEqual(new Date('2026-05-04T11:00:00.000Z'));
                expect(finishedAt).toEqual(new Date('2026-05-04T11:00:00.000Z'));
                return 'thread-discovered';
            },
            spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
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

        expect(result).toEqual({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-discovered',
        });
    });

    it('returns the native exit code when a fresh launch exits before discovery', async () => {
        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            discoverThreadId: () => new Promise<string>((_resolve, reject) => {
                setTimeout(() => reject(new Error('Could not discover Codex thread id')), 0);
            }),
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        callback(7);
                    }
                    return undefined;
                },
            })) as never,
        });

        expect(result).toEqual({ type: 'exit', code: 7 });
    });

    it('wraps native Codex in the configured Happy sandbox', async () => {
        const spawnCalls: unknown[] = [];
        const cleanupCalls: string[] = [];

        const result = await launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            sandboxConfig: {
                enabled: true,
                workspaceRoot: '/tmp/project',
                sessionIsolation: 'workspace',
                customWritePaths: [],
                denyReadPaths: [],
                extraWritePaths: [],
                denyWritePaths: [],
                networkMode: 'blocked',
                allowedDomains: [],
                deniedDomains: [],
                allowLocalBinding: false,
            },
            initializeSandbox: async (sandboxConfig, cwd) => {
                expect(sandboxConfig.enabled).toBe(true);
                expect(cwd).toBe('/tmp/project');
                return async () => {
                    cleanupCalls.push('cleanup');
                };
            },
            wrapForSandbox: async (command, args) => ({
                command: 'sh',
                args: ['-c', `sandboxed ${command} ${args.join(' ')}`],
            }),
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

        expect(result).toEqual({ type: 'exit', code: 0, codexThreadId: 'thread-existing' });
        expect(spawnCalls).toEqual([{
            command: 'sh',
            args: ['-c', 'sandboxed codex resume thread-existing'],
            options: expect.objectContaining({
                cwd: '/tmp/project',
                stdio: 'inherit',
            }),
        }]);
        expect(cleanupCalls).toEqual(['cleanup']);
    });

    it('publishes a discovered Codex thread id before the native process exits', async () => {
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const discovered: string[] = [];
        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            now: () => new Date('2026-05-04T11:00:00.000Z'),
            discoverThreadId: async () => 'thread-discovered',
            onThreadIdDiscovered: (threadId) => {
                discovered.push(threadId);
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(discovered).toEqual(['thread-discovered']);

        if (!exitCallback.current) {
            throw new Error('exit callback was not registered');
        }
        exitCallback.current(0);
        await expect(launch).resolves.toEqual({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-discovered',
        });
    });

    it('terminates the native process when discovery rejects while it is still running', async () => {
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];
        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            now: () => new Date('2026-05-04T11:00:00.000Z'),
            discoverThreadId: async () => {
                throw new Error('Ambiguous Codex thread discovery for cwd /tmp/project: one, two');
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await expect(launch).rejects.toThrow('Ambiguous Codex thread discovery');
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('switches to remote mode when a local handoff is requested', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        requestHandoff.current?.();

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-existing' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('waits for discovery before terminating native Codex for early fresh handoff', async () => {
        const requestHandoff: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const resolveDiscovery: { current: ((threadId: string) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexHomeDir: '/tmp/codex-home',
            discoverThreadId: () => new Promise<string>((resolve) => {
                resolveDiscovery.current = resolve;
            }),
            onLocalHandoffReady: (handoff) => {
                requestHandoff.current = handoff;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        requestHandoff.current?.();
        expect(killCalls).toEqual([]);

        resolveDiscovery.current?.('thread-discovered');

        await expect(launch).resolves.toEqual({ type: 'switch', codexThreadId: 'thread-discovered' });
        expect(killCalls).toEqual(['SIGTERM']);
    });

    it('exposes a termination callback that kills native Codex without switching modes', async () => {
        const terminate: { current: (() => void) | null } = { current: null };
        const exitCallback: { current: ((value: unknown) => void) | null } = { current: null };
        const killCalls: Array<string | undefined> = [];

        const launch = launchNativeCodex({
            cwd: '/tmp/project',
            codexThreadId: 'thread-existing',
            onTerminateReady: (terminateNative) => {
                terminate.current = terminateNative;
            },
            spawn: (() => ({
                once: (event: string, callback: (value: unknown) => void) => {
                    if (event === 'exit') {
                        exitCallback.current = callback;
                    }
                    return undefined;
                },
                kill: (signal?: string) => {
                    killCalls.push(signal);
                    exitCallback.current?.(null);
                    return true;
                },
            })) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        terminate.current?.();

        await expect(launch).resolves.toEqual({ type: 'exit', code: 1, codexThreadId: 'thread-existing' });
        expect(killCalls).toEqual(['SIGTERM']);
    });
});
