import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexAppServerClient, resolveCodexAppServerConnection } from './codexAppServerClient';

type JsonRpcMessage = {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
};

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('CodexAppServerClient shared Unix socket connection', () => {
    const cleanupTasks: Array<() => Promise<void>> = [];

    afterEach(async () => {
        while (cleanupTasks.length > 0) {
            await cleanupTasks.pop()?.();
        }
    });

    it('resolves explicit shared mode to the Codex control socket', () => {
        expect(resolveCodexAppServerConnection({
            HAPPY_CODEX_APP_SERVER_MODE: 'shared',
            CODEX_HOME: '/tmp/codex-home',
        })).toEqual({
            type: 'unixSocket',
            socketPath: '/tmp/codex-home/app-server-control/app-server-control.sock',
            approvalAuthority: 'desktop',
        });
        expect(resolveCodexAppServerConnection({
            HAPPY_CODEX_APP_SERVER_MODE: 'shared',
            HAPPY_CODEX_APP_SERVER_SOCKET: '/tmp/custom-codex.sock',
            HAPPY_CODEX_APPROVAL_AUTHORITY: 'paws',
        })).toEqual({
            type: 'unixSocket',
            socketPath: '/tmp/custom-codex.sock',
            approvalAuthority: 'paws',
        });
        expect(resolveCodexAppServerConnection({})).toEqual({ type: 'spawn' });
    });

    it('rejects ambiguous shared transport configuration before connecting to Codex', () => {
        expect(() => resolveCodexAppServerConnection({ HAPPY_CODEX_APP_SERVER_MODE: 'socket' }))
            .toThrow('expected "spawn" or "shared"');
        expect(() => resolveCodexAppServerConnection({
            HAPPY_CODEX_APP_SERVER_MODE: 'shared',
            HAPPY_CODEX_APP_SERVER_SOCKET: 'relative/app-server.sock',
        })).toThrow('must be an absolute path');
        expect(() => resolveCodexAppServerConnection({
            HAPPY_CODEX_APP_SERVER_MODE: 'shared',
            HAPPY_CODEX_APPROVAL_AUTHORITY: 'both',
        })).toThrow('expected "desktop" or "paws"');
    });

    it('closes its socket when the shared app-server rejects initialization', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'paws-codex-init-error-'));
        const socketPath = join(tempDir, 'app-server.sock');
        const server: Server = createServer();
        const webSocketServer = new WebSocketServer({ server });
        const connections = new Set<WebSocket>();
        cleanupTasks.push(async () => {
            for (const connection of connections) {
                connection.terminate();
            }
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(tempDir, { recursive: true, force: true });
        });

        webSocketServer.on('connection', (connection) => {
            connections.add(connection);
            connection.on('close', () => connections.delete(connection));
            connection.on('message', (data) => {
                const message = JSON.parse(data.toString()) as JsonRpcMessage;
                if (message.method === 'initialize' && message.id !== undefined) {
                    connection.send(JSON.stringify({
                        id: message.id,
                        error: { code: -32600, message: 'unsupported client' },
                    }));
                }
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        });

        const client = new CodexAppServerClient(undefined, { type: 'unixSocket', socketPath });
        await expect(client.connect()).rejects.toThrow('initialize: unsupported client');
        await waitFor(() => connections.size === 0);
    });

    it('lets two clients resume one thread without spawning their own Codex process', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'paws-codex-shared-'));
        const socketPath = join(tempDir, 'app-server.sock');
        const server: Server = createServer();
        const webSocketServer = new WebSocketServer({ server });
        const connections = new Set<WebSocket>();
        const resumedConnections = new Set<WebSocket>();
        const receivedMethods: string[][] = [];

        cleanupTasks.push(async () => {
            for (const connection of connections) {
                connection.terminate();
            }
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(tempDir, { recursive: true, force: true });
        });

        webSocketServer.on('connection', (connection) => {
            connections.add(connection);
            const connectionMethods: string[] = [];
            receivedMethods.push(connectionMethods);
            connection.on('close', () => connections.delete(connection));
            connection.on('message', (data) => {
                const message = JSON.parse(data.toString()) as JsonRpcMessage;
                if (message.method) {
                    connectionMethods.push(message.method);
                }
                if (message.method === 'initialize' && message.id !== undefined) {
                    connection.send(JSON.stringify({ id: message.id, result: { userAgent: 'test-app-server' } }));
                }
                if (message.method === 'thread/resume' && message.id !== undefined) {
                    resumedConnections.add(connection);
                    connection.send(JSON.stringify({
                        id: message.id,
                        result: {
                            thread: { id: 'thread-shared' },
                            model: 'gpt-test',
                            reasoningEffort: null,
                        },
                    }));
                }
            });
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        });

        const firstClient = new CodexAppServerClient(undefined, { type: 'unixSocket', socketPath });
        const secondClient = new CodexAppServerClient(undefined, { type: 'unixSocket', socketPath });
        const firstEvents: string[] = [];
        const secondEvents: string[] = [];
        firstClient.setEventHandler((event) => firstEvents.push(event.type));
        secondClient.setEventHandler((event) => secondEvents.push(event.type));

        const originalPath = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin';
        try {
            await Promise.all([firstClient.connect(), secondClient.connect()]);
        } finally {
            process.env.PATH = originalPath;
        }
        await Promise.all([
            firstClient.resumeThread({ threadId: 'thread-shared', cwd: tempDir }),
            secondClient.resumeThread({ threadId: 'thread-shared', cwd: tempDir }),
        ]);

        expect(connections.size).toBe(2);
        expect(resumedConnections.size).toBe(2);
        expect(receivedMethods).toEqual([
            ['initialize', 'initialized', 'thread/resume'],
            ['initialize', 'initialized', 'thread/resume'],
        ]);

        for (const connection of resumedConnections) {
            connection.send(JSON.stringify({
                method: 'turn/started',
                params: {
                    threadId: 'thread-shared',
                    turn: { id: 'turn-shared', status: 'inProgress' },
                },
            }));
        }
        await waitFor(() => firstEvents.includes('task_started') && secondEvents.includes('task_started'));

        await firstClient.disconnect();
        await waitFor(() => connections.size === 1);

        const remainingConnection = [...connections][0];
        remainingConnection.send(JSON.stringify({
            method: 'turn/completed',
            params: {
                threadId: 'thread-shared',
                turn: { id: 'turn-shared', status: 'completed' },
            },
        }));
        await waitFor(() => secondEvents.includes('task_complete'));
        expect(firstEvents).not.toContain('task_complete');

        await secondClient.disconnect();
    });

    it('routes shared-thread approval responses only through the configured Paws authority', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'paws-codex-approval-authority-'));
        const socketPath = join(tempDir, 'app-server.sock');
        const server: Server = createServer();
        const webSocketServer = new WebSocketServer({ server });
        const connections: WebSocket[] = [];
        const approvalResponses: unknown[] = [];

        cleanupTasks.push(async () => {
            for (const connection of connections) {
                connection.terminate();
            }
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(tempDir, { recursive: true, force: true });
        });

        webSocketServer.on('connection', (connection) => {
            connections.push(connection);
            connection.on('message', (data) => {
                const message = JSON.parse(data.toString()) as JsonRpcMessage;
                if (message.method === 'initialize' && message.id !== undefined) {
                    connection.send(JSON.stringify({ id: message.id, result: { userAgent: 'test-app-server' } }));
                }
                if (message.method === 'thread/resume' && message.id !== undefined) {
                    connection.send(JSON.stringify({
                        id: message.id,
                        result: {
                            thread: { id: 'thread-shared-approval' },
                            model: 'gpt-test',
                            reasoningEffort: null,
                        },
                    }));
                }
                if (message.id === 77 && message.result !== undefined) {
                    approvalResponses.push(message.result);
                }
            });
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        });

        const desktopAuthorityClient = new CodexAppServerClient(undefined, {
            type: 'unixSocket',
            socketPath,
            approvalAuthority: 'desktop',
        });
        const pawsAuthorityClient = new CodexAppServerClient(undefined, {
            type: 'unixSocket',
            socketPath,
            approvalAuthority: 'paws',
        });
        const defaultAuthorityClient = new CodexAppServerClient(undefined, {
            type: 'unixSocket',
            socketPath,
        });
        const desktopApprovalHandler = vi.fn(async () => 'denied' as const);
        const defaultApprovalHandler = vi.fn(async () => 'denied' as const);
        desktopAuthorityClient.setApprovalHandler(desktopApprovalHandler);
        pawsAuthorityClient.setApprovalHandler(async () => 'approved');
        defaultAuthorityClient.setApprovalHandler(defaultApprovalHandler);

        await desktopAuthorityClient.connect();
        await pawsAuthorityClient.connect();
        await defaultAuthorityClient.connect();
        await Promise.all([
            desktopAuthorityClient.resumeThread({ threadId: 'thread-shared-approval', cwd: tempDir }),
            pawsAuthorityClient.resumeThread({ threadId: 'thread-shared-approval', cwd: tempDir }),
            defaultAuthorityClient.resumeThread({ threadId: 'thread-shared-approval', cwd: tempDir }),
        ]);

        for (const connection of connections) {
            connection.send(JSON.stringify({
                id: 77,
                method: 'item/commandExecution/requestApproval',
                params: {
                    threadId: 'thread-shared-approval',
                    turnId: 'turn-approval',
                    itemId: 'item-approval',
                    command: 'printf ok',
                    cwd: tempDir,
                },
            }));
        }

        await waitFor(() => approvalResponses.length >= 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(approvalResponses).toEqual([{ decision: 'accept' }]);
        expect(desktopApprovalHandler).not.toHaveBeenCalled();
        expect(defaultApprovalHandler).not.toHaveBeenCalled();

        await Promise.all([
            desktopAuthorityClient.disconnect(),
            pawsAuthorityClient.disconnect(),
            defaultAuthorityClient.disconnect(),
        ]);
    });
});
