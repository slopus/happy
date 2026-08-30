import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';

async function waitForSocket(socketPath: string, process: ChildProcess, timeoutMs: number = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) {
            throw new Error(`Codex app-server exited before creating its control socket (code ${process.exitCode})`);
        }
        try {
            await access(socketPath);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error(`Timed out waiting for Codex app-server socket: ${socketPath}`);
}

describe('shared Codex app-server process', () => {
    const cleanupTasks: Array<() => Promise<void>> = [];

    afterEach(async () => {
        while (cleanupTasks.length > 0) {
            await cleanupTasks.pop()?.();
        }
    });

    it(
        'serves one thread to two Paws clients through one Unix socket',
        async () => {
            // Unix domain sockets have a short platform path limit (SUN_LEN).
            const tempDir = await mkdtemp('/tmp/paws-codex-');
            const codexHome = join(tempDir, 'codex-home');
            const socketPath = join(codexHome, 'app-server-control', 'app-server-control.sock');
            await mkdir(join(codexHome, 'app-server-control'), { recursive: true });

            const codexBin = process.env.PAWS_CODEX_INTEGRATION_BIN || 'codex';
            const appServer = spawn(codexBin, [
                'app-server',
                '--listen',
                `unix://${socketPath}`,
            ], {
                env: { ...process.env, CODEX_HOME: codexHome },
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            const stderr: Buffer[] = [];
            appServer.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
            cleanupTasks.push(async () => {
                if (appServer.exitCode === null) {
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(() => {
                            appServer.kill('SIGKILL');
                        }, 2_000);
                        timer.unref();
                        appServer.once('exit', () => {
                            clearTimeout(timer);
                            resolve();
                        });
                        appServer.kill('SIGTERM');
                    });
                }
                await rm(tempDir, { recursive: true, force: true });
            });

            try {
                await waitForSocket(socketPath, appServer);
            } catch (error) {
                const details = Buffer.concat(stderr).toString().trim();
                throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ''}`);
            }

            const firstClient = new CodexAppServerClient(undefined, { type: 'unixSocket', socketPath });
            const secondClient = new CodexAppServerClient(undefined, { type: 'unixSocket', socketPath });
            cleanupTasks.push(async () => {
                await Promise.allSettled([firstClient.disconnect(), secondClient.disconnect()]);
            });

            await Promise.all([firstClient.connect(), secondClient.connect()]);
            const started = await firstClient.startThread({ cwd: tempDir });
            await firstClient.injectItems({
                threadId: started.threadId,
                items: [{
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'shared app-server transport probe' }],
                }],
            });
            const resumed = await secondClient.resumeThread({ threadId: started.threadId, cwd: tempDir });

            expect(resumed.threadId).toBe(started.threadId);
            expect(appServer.exitCode).toBeNull();
        },
        30_000,
    );
});
