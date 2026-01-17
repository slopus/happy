/**
 * Tests for the `detect-cli` RPC handler.
 *
 * Ensures the daemon can reliably detect whether CLIs are resolvable on PATH
 * without relying on a login shell.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { registerCommonHandlers } from './registerCommonHandlers';
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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

    registerCommonHandlers(manager, process.cwd());

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

describe('registerCommonHandlers detect-cli', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('returns available=true when an executable exists on PATH', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-cli-detect-cli-'));
        try {
            const isWindows = process.platform === 'win32';
            const fakeClaude = join(dir, isWindows ? 'claude.cmd' : 'claude');
            await writeFile(fakeClaude, isWindows ? '@echo ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
            if (!isWindows) {
                await chmod(fakeClaude, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }

            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<{
                path: string | null;
                clis: Record<'claude' | 'codex' | 'gemini', { available: boolean; resolvedPath?: string }>;
            }, {}>('detect-cli', {});

            expect(result.path).toBe(dir);
            expect(result.clis.claude.available).toBe(true);
            expect(result.clis.claude.resolvedPath).toBe(fakeClaude);
            expect(result.clis.codex.available).toBe(false);
            expect(result.clis.gemini.available).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
