/**
 * Tests for the checklist-based capabilities RPCs:
 * - capabilities.describe
 * - capabilities.detect
 *
 * These replace legacy detect-cli / detect-capabilities / dep-status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { registerSessionHandlers } from './registerSessionHandlers';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { RPC_METHODS } from '@happy/protocol/rpc';
import { CHECKLIST_IDS, resumeChecklistId } from '@happy/protocol/checklists';

function createTestRpcManager(params?: { scopePrefix?: string }) {
    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptionVariant = 'legacy' as const;
    const scopePrefix = params?.scopePrefix ?? 'machine-test';

    const manager = new RpcHandlerManager({
        scopePrefix,
        encryptionKey,
        encryptionVariant,
        logger: () => undefined,
    });

    registerSessionHandlers(manager, process.cwd());

    async function call<TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> {
        const encryptedParams = encodeBase64(encrypt(encryptionKey, encryptionVariant, request));
        const rpcRequest: RpcRequest = {
            method: `${scopePrefix}:${method}`,
            params: encryptedParams,
        };
        const encryptedResponse = await manager.handleRequest(rpcRequest);
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedResponse));
        return decrypted as TResponse;
    }

    return { call };
}

describe('registerCommonHandlers capabilities', () => {
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;

    beforeEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;

        if (originalPathext === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = originalPathext;
    });

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;

        if (originalPathext === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = originalPathext;
    });

    it('describes supported capabilities and checklists', async () => {
        const { call } = createTestRpcManager();
        const result = await call<{
            protocolVersion: 1;
            capabilities: Array<{ id: string; kind: string }>;
            checklists: Record<string, Array<{ id: string; params?: any }>>;
        }, {}>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});

        expect(result.protocolVersion).toBe(1);
        expect(result.capabilities.map((c) => c.id)).toEqual(
            expect.arrayContaining(['cli.codex', 'cli.claude', 'cli.gemini', 'cli.opencode', 'tool.tmux', 'dep.codex-mcp-resume']),
        );
        expect(Object.keys(result.checklists)).toEqual(
            expect.arrayContaining([
                CHECKLIST_IDS.NEW_SESSION,
                CHECKLIST_IDS.MACHINE_DETAILS,
                resumeChecklistId('claude'),
                resumeChecklistId('codex'),
                resumeChecklistId('gemini'),
                resumeChecklistId('opencode'),
            ]),
        );
        expect(result.checklists[resumeChecklistId('codex')].map((r) => r.id)).toEqual(
            expect.arrayContaining(['cli.codex', 'dep.codex-mcp-resume']),
        );
    });

    it('detects checklist new-session deterministically from PATH', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-cli-capabilities-'));
        try {
            const isWindows = process.platform === 'win32';

            const fakeCodex = join(dir, isWindows ? 'codex.cmd' : 'codex');
            const fakeClaude = join(dir, isWindows ? 'claude.cmd' : 'claude');
            const fakeGemini = join(dir, isWindows ? 'gemini.cmd' : 'gemini');
            const fakeOpenCode = join(dir, isWindows ? 'opencode.cmd' : 'opencode');
            const fakeTmux = join(dir, isWindows ? 'tmux.cmd' : 'tmux');

            await writeFile(
                fakeCodex,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo codex 1.2.3& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 1.2.3"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeClaude,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo claude 0.1.0& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.1.0"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeGemini,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo gemini 9.9.9& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gemini 9.9.9"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeOpenCode,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo opencode 0.1.48& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 0.1.48"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeTmux,
                isWindows
                    ? '@echo off\r\nif "%1"=="-V" (echo tmux 3.3a& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux 3.3a"; exit 0; fi\necho ok\n',
                'utf8',
            );

            if (!isWindows) {
                await chmod(fakeCodex, 0o755);
                await chmod(fakeClaude, 0o755);
                await chmod(fakeGemini, 0o755);
                await chmod(fakeOpenCode, 0o755);
                await chmod(fakeTmux, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }

            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<{
                protocolVersion: 1;
                results: Record<
                    string,
                    { ok: boolean; data?: any; error?: any; checkedAt: number }
                >;
            }, { checklistId: string }>(RPC_METHODS.CAPABILITIES_DETECT, { checklistId: CHECKLIST_IDS.NEW_SESSION });

            expect(result.protocolVersion).toBe(1);
            expect(result.results['cli.codex'].ok).toBe(true);
            expect(result.results['cli.codex'].data.available).toBe(true);
            expect(result.results['cli.codex'].data.resolvedPath).toBe(fakeCodex);
            expect(result.results['cli.codex'].data.version).toBe('1.2.3');

            expect(result.results['cli.claude'].ok).toBe(true);
            expect(result.results['cli.claude'].data.available).toBe(true);
            expect(result.results['cli.claude'].data.version).toBe('0.1.0');

            expect(result.results['cli.gemini'].ok).toBe(true);
            expect(result.results['cli.gemini'].data.available).toBe(true);
            expect(result.results['cli.gemini'].data.version).toBe('9.9.9');

            expect(result.results['cli.opencode'].ok).toBe(true);
            expect(result.results['cli.opencode'].data.available).toBe(true);
            expect(result.results['cli.opencode'].data.resolvedPath).toBe(fakeOpenCode);
            expect(result.results['cli.opencode'].data.version).toBe('0.1.48');

            expect(result.results['tool.tmux'].ok).toBe(true);
            expect(result.results['tool.tmux'].data.available).toBe(true);
            expect(result.results['tool.tmux'].data.version).toBe('3.3a');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('supports per-capability params (includeLoginStatus) and skips registry checks when onlyIfInstalled=true and not installed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-cli-capabilities-login-'));
        try {
            const isWindows = process.platform === 'win32';
            const fakeCodex = join(dir, isWindows ? 'codex.cmd' : 'codex');
            await writeFile(
                fakeCodex,
                isWindows
                    ? '@echo off\r\nif \"%1\"==\"login\" if \"%2\"==\"status\" (echo ok& exit /b 0)\r\nif \"%1\"==\"--version\" (echo codex 1.2.3& exit /b 0)\r\necho nope& exit /b 1\r\n'
                    : '#!/bin/sh\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo ok; exit 0; fi\nif [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi\necho nope; exit 1;\n',
                'utf8',
            );
            if (!isWindows) {
                await chmod(fakeCodex, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }
            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<{
                results: Record<string, { ok: boolean; data?: any }>;
            }, {
                requests: Array<{ id: string; params?: any }>;
            }>(RPC_METHODS.CAPABILITIES_DETECT, {
                requests: [
                    { id: 'cli.codex', params: { includeLoginStatus: true } },
                    { id: 'dep.codex-mcp-resume', params: { includeRegistry: true, onlyIfInstalled: true } },
                ],
            });

            expect(result.results['cli.codex'].ok).toBe(true);
            expect(result.results['cli.codex'].data.isLoggedIn).toBe(true);

            expect(result.results['dep.codex-mcp-resume'].ok).toBe(true);
            expect(result.results['dep.codex-mcp-resume'].data.installed).toBe(false);
            expect(result.results['dep.codex-mcp-resume'].data.registry).toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
