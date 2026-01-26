import { spawn, type ChildProcess } from 'node:child_process';
import {
    ClientSideConnection,
    ndJsonStream,
    PROTOCOL_VERSION,
    type Agent,
    type Client,
    type InitializeRequest,
    type InitializeResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from '@agentclientprotocol/sdk';

import { logger } from '@/ui/logger';
import type { TransportHandler } from '@/agent/transport';
import { nodeToWebStreams } from '@/agent/acp/nodeToWebStreams';

type AcpProbeResult =
    | { ok: true; checkedAt: number; agentCapabilities: InitializeResponse['agentCapabilities'] }
    | { ok: false; checkedAt: number; error: { message: string } };

async function terminateProcess(child: ChildProcess): Promise<void> {
    if (child.killed) return;

    const waitForExit = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
    });

    try {
        child.kill('SIGTERM');
    } catch {
        // ignore
    }

    await Promise.race([
        waitForExit,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);

    if (!child.killed) {
        try {
            child.kill('SIGKILL');
        } catch {
            // ignore
        }
    }
}

export async function probeAcpAgentCapabilities(params: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    transport: TransportHandler;
    timeoutMs?: number;
}): Promise<AcpProbeResult> {
    const checkedAt = Date.now();
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 2500;

    let child: ChildProcess | null = null;
    try {
        const isWindows = process.platform === 'win32';
        const env = { ...process.env, ...params.env };

        if (isWindows) {
            child = spawn(params.command, params.args, {
                cwd: params.cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
                windowsHide: true,
            });
        } else {
            child = spawn(params.command, params.args, {
                cwd: params.cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }

        if (!child.stdin || !child.stdout || !child.stderr) {
            throw new Error('Failed to create stdio pipes');
        }

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            if (text.trim()) {
                logger.debug(`[acpProbe] stderr(${params.transport.agentName}): ${text.trim()}`);
            }
        });

        const { writable, readable } = nodeToWebStreams(child.stdin, child.stdout);

        const filteredReadable = new ReadableStream<Uint8Array>({
            async start(controller) {
                const reader = readable.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                let buffer = '';
                let filteredCount = 0;

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (buffer.trim()) {
                                const filtered = params.transport.filterStdoutLine?.(buffer);
                                if (filtered === undefined) controller.enqueue(encoder.encode(buffer));
                                else if (filtered !== null) controller.enqueue(encoder.encode(filtered));
                                else filteredCount++;
                            }
                            if (filteredCount > 0) {
                                logger.debug(`[acpProbe] filtered ${filteredCount} lines from ${params.transport.agentName} stdout`);
                            }
                            controller.close();
                            break;
                        }

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            const filtered = params.transport.filterStdoutLine?.(line);
                            if (filtered === undefined) controller.enqueue(encoder.encode(`${line}\n`));
                            else if (filtered !== null) controller.enqueue(encoder.encode(`${filtered}\n`));
                            else filteredCount++;
                        }
                    }
                } catch (error) {
                    controller.error(error);
                } finally {
                    reader.releaseLock();
                }
            },
        });

        const stream = ndJsonStream(writable, filteredReadable);

        const client: Client = {
            sessionUpdate: async (_params: SessionNotification) => {},
            requestPermission: async (_params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                // Probe should never ask for permissions; fail closed if it does.
                return { outcome: { outcome: 'selected', optionId: 'cancel' } };
            },
        };

        const connection = new ClientSideConnection((_agent: Agent) => client, stream);

        const initRequest: InitializeRequest = {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
            },
            clientInfo: { name: 'happy-cli-capabilities', version: '0' },
        };

        const initResponse = await Promise.race([
            connection.initialize(initRequest),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`ACP initialize timeout after ${timeoutMs}ms`)), timeoutMs)),
        ]);

        return { ok: true, checkedAt, agentCapabilities: initResponse.agentCapabilities };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, checkedAt, error: { message } };
    } finally {
        if (child) {
            await terminateProcess(child);
        }
    }
}
