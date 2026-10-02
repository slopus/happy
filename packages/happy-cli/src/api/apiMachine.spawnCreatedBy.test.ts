import { describe, expect, it, vi } from 'vitest';

function machineClient(encryptionVariant: 'legacy' | 'dataKey' = 'legacy') {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant,
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

function rpcHandlers(overrides: Record<string, unknown> = {}) {
    return {
        spawnSession: () => Promise.resolve({ type: 'success', sessionId: 'happy-1' }),
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: {
            allocate: () => undefined,
            get: () => undefined,
            release: () => undefined,
            list: () => [],
            sweep: () => undefined,
        },
        ...overrides,
    } as any;
}

describe('ApiMachineClient spawn/resume RPC passthrough', () => {
    it.each([
        { label: 'null', params: null },
        { label: 'string', params: 'invalid' },
        { label: 'array', params: [] },
    ])(
        'rejects $label spawn params before invoking spawnSession',
        async ({ params }) => {
            const spawnSession = vi.fn();
            const { ApiMachineClient } = await import('./apiMachine');
            const client = new ApiMachineClient('token', machineClient());
            client.setRPCHandlers(rpcHandlers({ spawnSession }));

            await expect(
                handlersFrom(client).get('machine-1:spawn-happy-session')?.(params)
            ).rejects.toThrow('Spawn parameters must be an object');
            expect(spawnSession).not.toHaveBeenCalled();
        }
    );

    it('refuses empty dataKey params before dispatch without spawning a session', async () => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const { decodeBase64, decrypt } = await import('./encryption');
        const machine = machineClient('dataKey');
        const client = new ApiMachineClient('token', machine);
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        const encryptedResponse = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:spawn-happy-session',
            params: '',
        });

        expect(decrypt(machine.encryptionKey, 'dataKey', decodeBase64(encryptedResponse))).toMatchObject({
            code: 'RPC_DECRYPT_FAILED',
        });
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('rejects authenticated null dataKey params without spawning a session', async () => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const { decodeBase64, decrypt, encodeBase64, encrypt } = await import('./encryption');
        const machine = machineClient('dataKey');
        const client = new ApiMachineClient('token', machine);
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        const encryptedResponse = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:spawn-happy-session',
            params: encodeBase64(encrypt(machine.encryptionKey, 'dataKey', null)),
        });

        expect(decrypt(machine.encryptionKey, 'dataKey', decodeBase64(encryptedResponse))).toEqual({
            error: 'Spawn parameters must be an object',
        });
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('forwards only the encrypted MCP caller grant envelope to spawnSession', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            mcpCallerGrantEnvelope: 'ENCRYPTED-ONLY',
            mcpConfigProjectId: 'P-1',
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            mcpCallerGrantEnvelope: 'ENCRYPTED-ONLY',
            mcpConfigProjectId: 'P-1',
        }));
        expect(spawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
            mcpCallerGrant: expect.anything(),
        }));
    });

    it('forwards expected connector provider names to spawn and rejects account-shaped values', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));
        const handler = handlersFrom(client).get('machine-1:spawn-happy-session');

        await handler?.({
            directory: '/tmp/project',
            agent: 'codex',
            expectedConnectors: ['gmail', 'knoi'],
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            expectedConnectors: ['gmail', 'knoi'],
        }));
        await expect(handler?.({
            directory: '/tmp/project',
            agent: 'codex',
            expectedConnectors: ['private@example.com'],
        })).rejects.toThrow('Expected connectors must contain provider names only');
    });

    it('forwards createdByAccountId/createdByDisplayName to spawnSession', async () => {
        const calls: any[] = [];
        const spawnSession = (options: any) => {
            calls.push(options);
            return Promise.resolve({ type: 'success', sessionId: 'happy-1' });
        };

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        const result = await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            createdByAccountId: 'acct-123',
            createdByDisplayName: 'Ada',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-1' });
        expect(calls).toEqual([expect.objectContaining({
            directory: '/tmp/project',
            agent: 'claude',
            createdByAccountId: 'acct-123',
            createdByDisplayName: 'Ada',
        })]);
    });

    it('omits createdBy fields from spawnSession when not supplied (backward compatible)', async () => {
        const calls: any[] = [];
        const spawnSession = (options: any) => {
            calls.push(options);
            return Promise.resolve({ type: 'success', sessionId: 'happy-1' });
        };

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
        });

        expect(calls[0].createdByAccountId).toBeUndefined();
        expect(calls[0].createdByDisplayName).toBeUndefined();
    });

    it('forwards axStep and bootstrapFiles to spawnSession', async () => {
        const calls: any[] = [];
        const spawnSession = (options: any) => {
            calls.push(options);
            return Promise.resolve({ type: 'success', sessionId: 'happy-1' });
        };
        const bootstrapFiles = [{
            relativePath: '.aplus/agent/project-template.md',
            content: '# Project',
        }];

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            axStep: 'plan',
            bootstrapFiles,
        });

        expect(calls[0]).toEqual(expect.objectContaining({
            axStep: 'plan',
            bootstrapFiles,
        }));
    });

    it.each(['claude', 'codex'])('forwards an atomic run-once prompt for %s', async (agent) => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent,
            initialPrompt: 'PR #42를 리뷰해줘',
            exitAfterFirstTurn: true,
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent,
            initialPrompt: 'PR #42를 리뷰해줘',
            exitAfterFirstTurn: true,
        }));
    });

    it('forwards the browser continuation mark of a run-once host that parks the session', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project', agent: 'claude', initialPrompt: 'open the form', exitAfterFirstTurn: true, browserContinuation: true,
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ exitAfterFirstTurn: true, browserContinuation: true }));
    });

    it.each(['claude', 'codex', 'gemini', 'grok', 'openclaw', 'opencode'])(
        'forwards deferred continuation context without starting an initial turn for %s',
        async (agent) => {
            const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
            const { ApiMachineClient } = await import('./apiMachine');
            const client = new ApiMachineClient('token', machineClient());
            client.setRPCHandlers(rpcHandlers({ spawnSession }));

            await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
                directory: '/tmp/project',
                agent,
                deferredContinuationContext: 'Earlier transcript context',
            });

            expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
                agent,
                deferredContinuationContext: 'Earlier transcript context',
            }));
            expect(spawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
                initialPrompt: expect.anything(),
            }));
        },
    );

    it.each([
        { value: '', message: 'Deferred continuation context must be a non-empty string' },
        { value: 42, message: 'Deferred continuation context must be a non-empty string' },
        { value: 'a'.repeat(256 * 1024 + 1), message: 'Deferred continuation context is too large' },
    ])('rejects invalid deferred continuation context: $message', async ({ value, message }) => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await expect(handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'codex',
            deferredContinuationContext: value,
        })).rejects.toThrow(message);
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it.each([
        { params: { exitAfterFirstTurn: true }, message: 'Run-once session requires a non-empty initial prompt' },
        { params: { initialPrompt: 42 }, message: 'Initial prompt must be a non-empty string' },
        { params: { initialPrompt: 'review', exitAfterFirstTurn: 'true' }, message: 'Exit-after-first-turn must be a boolean' },
        { params: { agent: 'opencode', initialPrompt: 'review', exitAfterFirstTurn: true }, message: 'Run-once session is only supported for Claude and Codex' },
        { params: { initialPrompt: 'review', exitAfterFirstTurn: true, browserContinuation: 'yes' }, message: 'Browser continuation must be a boolean' },
        { params: { initialPrompt: 'review', browserContinuation: true }, message: 'Browser continuation is only for a run-once session' },
    ])('rejects invalid run-once spawn params: $message', async ({ params, message }) => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await expect(handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            ...params,
        })).rejects.toThrow(message);
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('forwards encrypted MCP grant fields to resumeSession', async () => {
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ resumeSession }));

        await handlersFrom(client).get('machine-1:resume-happy-session')?.({
            sessionId: 'happy-1',
            permissionMode: 'bypassPermissions',
            environmentVariables: { ORG_SECRET: 'resume-secret' },
            mcpCallerGrantEnvelope: 'ENCRYPTED-RESUME-GRANT',
            mcpConfigProjectId: 'P-1',
            expectedConnectors: ['gmail', 'knoi'],
        });

        expect(resumeSession).toHaveBeenCalledWith('happy-1', expect.objectContaining({
            permissionMode: 'bypassPermissions',
            environmentVariables: { ORG_SECRET: 'resume-secret' },
            mcpCallerGrantEnvelope: 'ENCRYPTED-RESUME-GRANT',
            mcpConfigProjectId: 'P-1',
            expectedConnectors: ['gmail', 'knoi'],
        }));
    });

    it('forwards the current additional directories so a resume replaces the granted roots', async () => {
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ resumeSession }));
        const resume = handlersFrom(client).get('machine-1:resume-happy-session');

        await resume?.({ sessionId: 'happy-1', additionalDirectories: ['/repo/app'] });
        await resume?.({ sessionId: 'happy-1', additionalDirectories: [] });
        await resume?.({ sessionId: 'happy-1' });

        expect(resumeSession.mock.calls.map(([, options]) => options.additionalDirectories))
            .toEqual([['/repo/app'], [], undefined]);
        await expect(resume?.({ sessionId: 'happy-1', additionalDirectories: ['relative'] }))
            .rejects.toThrow('safe absolute paths');
    });

    it('returns a structured untracked error without throwing away its code', async () => {
        const resumeSession = vi.fn().mockResolvedValue({
            type: 'error',
            code: 'SESSION_NOT_TRACKED',
            errorMessage: 'Session happy-1 is not tracked by this daemon.',
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ resumeSession }));

        await expect(handlersFrom(client).get('machine-1:resume-happy-session')?.({
            sessionId: 'happy-1',
        })).resolves.toEqual({
            type: 'error',
            code: 'SESSION_NOT_TRACKED',
            errorMessage: 'Session happy-1 is not tracked by this daemon.',
        });
    });

    it('forwards an atomic first prompt and recovery context to recoverSession', async () => {
        const recoverSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'happy-new',
            previousSessionId: 'happy-old',
            recovery: 'new-session',
            initialPromptDelivered: true,
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ recoverSession }));

        await expect(handlersFrom(client).get('machine-1:recover-happy-session')?.({
            sessionId: 'happy-old',
            initialPrompt: '이어서 작업해줘',
            initialPromptLocalId: 'web-local-1',
            appendSystemPrompt: 'USER PROJECT CONTEXT',
            environmentVariables: { PROJECT_TOKEN: '${PROJECT_TOKEN}' },
            model: 'opus',
            permissionMode: 'bypassPermissions',
            saycodeSystemPromptEnabled: false,
            saycodePromptBlocks: { workerDelegation: false },
            mcpCallerGrantEnvelope: 'ENCRYPTED-RECOVERY-GRANT',
            mcpConfigProjectId: 'P-1',
            expectedConnectors: ['gmail', 'knoi'],
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'happy-new',
            previousSessionId: 'happy-old',
            recovery: 'new-session',
            initialPromptDelivered: true,
        });
        expect(recoverSession).toHaveBeenCalledWith('happy-old', {
            initialPrompt: '이어서 작업해줘',
            initialPromptLocalId: 'web-local-1',
            appendSystemPrompt: 'USER PROJECT CONTEXT',
            environmentVariables: { PROJECT_TOKEN: '${PROJECT_TOKEN}' },
            model: 'opus',
            permissionMode: 'bypassPermissions',
            saycodeSystemPromptEnabled: false,
            saycodePromptBlocks: { workerDelegation: false },
            mcpCallerGrantEnvelope: 'ENCRYPTED-RECOVERY-GRANT',
            mcpConfigProjectId: 'P-1',
            expectedConnectors: ['gmail', 'knoi'],
        });
    });

    it('sanitizes a malformed saycodePromptBlocks instead of failing the recovery', async () => {
        // A preference must never abort a recovery: non-boolean entries are dropped
        // and a non-object value degrades to undefined (legacy master inheritance),
        // mirroring MessageMetaSchema's catch(undefined) on the wire.
        const recoverSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-new' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ recoverSession }));

        await handlersFrom(client).get('machine-1:recover-happy-session')?.({
            sessionId: 'happy-old',
            initialPrompt: '이어서 작업해줘',
            saycodePromptBlocks: { workerDelegation: 'no', axBase: false },
        });
        expect(recoverSession).toHaveBeenCalledWith('happy-old', expect.objectContaining({
            saycodePromptBlocks: { axBase: false },
        }));

        recoverSession.mockClear();
        await handlersFrom(client).get('machine-1:recover-happy-session')?.({
            sessionId: 'happy-old',
            initialPrompt: '이어서 작업해줘',
            saycodePromptBlocks: 'broken',
        });
        expect(recoverSession).toHaveBeenCalledWith('happy-old', expect.objectContaining({
            saycodePromptBlocks: undefined,
        }));
    });
});
