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
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;

    beforeEach(() => {
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        if (originalPathext === undefined) {
            delete process.env.PATHEXT;
        } else {
            process.env.PATHEXT = originalPathext;
        }
    });

    afterEach(() => {
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        if (originalPathext === undefined) {
            delete process.env.PATHEXT;
        } else {
            process.env.PATHEXT = originalPathext;
        }
    });

    it('returns available=true when an executable exists on PATH', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-cli-detect-cli-'));
        try {
            const isWindows = process.platform === 'win32';
            const fakeClaude = join(dir, isWindows ? 'claude.cmd' : 'claude');
            await writeFile(
                fakeClaude,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo claude 0.1.0) else (echo ok)\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.1.0"; else echo ok; fi\n',
                'utf8',
            );
            if (!isWindows) {
                await chmod(fakeClaude, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }

            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<{
                path: string | null;
                clis: Record<'claude' | 'codex' | 'gemini', { available: boolean; resolvedPath?: string; version?: string }>;
                tmux: { available: boolean; resolvedPath?: string; version?: string };
            }, {}>('detect-cli', {});

            expect(result.path).toBe(dir);
            expect(result.clis.claude.available).toBe(true);
            expect(result.clis.claude.resolvedPath).toBe(fakeClaude);
            expect(result.clis.claude.version).toBe('0.1.0');
            expect(result.clis.codex.available).toBe(false);
            expect(result.clis.gemini.available).toBe(false);
            expect(result.tmux.available).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('can optionally include login status (best-effort)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-cli-detect-cli-login-'));
        try {
            const isWindows = process.platform === 'win32';
            const fakeCodex = join(dir, isWindows ? 'codex.cmd' : 'codex');
            await writeFile(
                fakeCodex,
                isWindows
                    ? '@echo off\r\nif "%1"=="login" if "%2"=="status" (echo ok& exit /b 0)\r\nif "%1"=="--version" (echo codex 1.2.3& exit /b 0)\r\necho nope& exit /b 1\r\n'
                    : '#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo ok; exit 0; fi\nif [ "$1" = "--version" ]; then echo "codex 1.2.3"; exit 0; fi\necho nope; exit 1;\n',
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
                path: string | null;
                clis: Record<'claude' | 'codex' | 'gemini', { available: boolean; isLoggedIn?: boolean | null }>;
            }, { includeLoginStatus: boolean }>('detect-cli', { includeLoginStatus: true });

            expect(result.path).toBe(dir);
            expect(result.clis.codex.available).toBe(true);
            expect(result.clis.codex.isLoggedIn).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('detects tmux when available on PATH', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-cli-detect-tmux-'));
        try {
            const isWindows = process.platform === 'win32';
            const fakeTmux = join(dir, isWindows ? 'tmux.cmd' : 'tmux');
            await writeFile(
                fakeTmux,
                isWindows
                    ? '@echo off\r\nif "%1"=="-V" (echo tmux 3.3a& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux 3.3a"; exit 0; fi\necho ok\n',
                'utf8',
            );
            if (!isWindows) {
                await chmod(fakeTmux, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }

            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<{
                path: string | null;
                clis: Record<'claude' | 'codex' | 'gemini', { available: boolean }>;
                tmux: { available: boolean; resolvedPath?: string; version?: string };
            }, {}>('detect-cli', {});

            expect(result.path).toBe(dir);
            expect(result.tmux.available).toBe(true);
            expect(result.tmux.resolvedPath).toBe(fakeTmux);
            expect(result.tmux.version).toBe('3.3a');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
