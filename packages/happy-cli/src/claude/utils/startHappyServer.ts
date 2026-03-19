/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Supports multiple sessions to handle mode switching (local <-> remote)
 * where each mode spawns a new Claude Code process that needs to connect.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { shouldEnableOrchestratorTools } from '@/orchestrator/prompt';
import { applyDefaultWorkingDirectory } from '@/orchestrator/common';
import {
    ORCHESTRATOR_CANCEL_TOOL_SCHEMA,
    ORCHESTRATOR_GET_CONTEXT_TOOL_SCHEMA,
    ORCHESTRATOR_LIST_TOOL_SCHEMA,
    ORCHESTRATOR_PEND_TOOL_SCHEMA,
    ORCHESTRATOR_SEND_MESSAGE_TOOL_SCHEMA,
    ORCHESTRATOR_SUBMIT_TOOL_SCHEMA,
} from '@/orchestrator/mcpToolSchemas';
import { CLAUDE_MODEL_MODES, CODEX_MODEL_MODES, GEMINI_MODEL_MODES } from 'happy-wire';

const ORCHESTRATOR_RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_BLOCKING_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function toToolSuccess(data: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(data, null, 2),
            },
        ],
        isError: false,
    };
}

function toToolError(message: string, details?: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify({
                    ok: false,
                    error: message,
                    ...(details !== undefined ? { details } : {}),
                }, null, 2),
            },
        ],
        isError: true,
    };
}

// Factory function to create MCP server with tools
function createMcpServer(client: ApiSessionClient, options: { enableOrchestratorTools: boolean }): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        if (client.isTitlePinned) {
            return { success: false, error: 'Title is pinned by user and cannot be changed automatically' };
        }
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool('preview_html', {
        description: 'Preview an HTML page in the client app. The HTML must be a complete, self-contained document with all CSS and JS inlined.',
        title: 'Preview HTML',
        inputSchema: {
            html: z.string().describe('Complete self-contained HTML document string'),
            title: z.string().optional().describe('Display title for the preview'),
        },
    }, async (args) => {
        logger.debug('[happyMCP] Preview HTML:', args.title || 'Untitled');
        return {
            content: [{
                type: 'text',
                text: `HTML preview ready: ${args.title || 'Untitled'}`,
            }],
            isError: false,
        };
    });

    if (options.enableOrchestratorTools) {
        const awaitRunTerminal = async (runId: string, waitTimeoutMs: number, pendTimeoutMs: number) => {
            const startedAt = Date.now();
            const deadline = startedAt + waitTimeoutMs;
            let cursor: string | undefined;
            let lastPend: any = null;

            while (Date.now() < deadline) {
                const remaining = deadline - Date.now();
                const timeoutMs = Math.max(0, Math.min(remaining, pendTimeoutMs));
                if (timeoutMs <= 0) {
                    break;
                }

                let pend: any;
                try {
                    pend = await client.orchestratorPend(runId, {
                        cursor,
                        waitFor: 'terminal',
                        timeoutMs,
                        include: 'summary',
                    });
                } catch (error: any) {
                    if (error?.response?.status === 504) continue; // Retry on gateway timeout
                    throw error;
                }
                lastPend = pend?.data ?? null;
                cursor = lastPend?.cursor;

                if (lastPend?.terminal) {
                    const finalRun = await client.orchestratorGetRun(runId, true);
                    return {
                        terminal: true,
                        timedOut: false,
                        waitedMs: Date.now() - startedAt,
                        lastPend,
                        run: finalRun?.data ?? null,
                    };
                }
            }

            const snapshot = await client.orchestratorGetRun(runId, true);
            const terminal = ORCHESTRATOR_RUN_TERMINAL.has(snapshot?.data?.status);
            return {
                terminal,
                timedOut: !terminal,
                waitedMs: Date.now() - startedAt,
                lastPend,
                run: snapshot?.data ?? null,
            };
        };

        mcp.registerTool('orchestrator_get_context', ORCHESTRATOR_GET_CONTEXT_TOOL_SCHEMA, async () => {
            try {
                const metadata = client.getMetadataSnapshot();
                const fallback = {
                    controllerSessionId: client.sessionId,
                    machineId: metadata?.machineId ?? null,
                    workingDirectory: metadata?.path ?? null,
                    defaults: {
                        mode: 'async',
                        maxConcurrency: 2,
                        waitTimeoutMs: DEFAULT_BLOCKING_WAIT_TIMEOUT_MS,
                        pollIntervalMs: 30_000,
                        retryMaxAttempts: 1,
                        retryBackoffMs: 0,
                    },
                    providers: ['claude', 'codex', 'gemini'],
                    modelModes: {
                        claude: CLAUDE_MODEL_MODES,
                        codex: CODEX_MODEL_MODES,
                        gemini: GEMINI_MODEL_MODES,
                    },
                    machines: [],
                };
                try {
                    const response = await client.orchestratorGetContext();
                    const data = response?.data ?? null;
                    if (data) {
                        return toToolSuccess({
                            ok: true,
                            data: {
                                ...fallback,
                                defaults: data.defaults ?? fallback.defaults,
                                providers: data.providers ?? fallback.providers,
                                modelModes: data.modelModes ?? fallback.modelModes,
                                machines: data.machines ?? [],
                            },
                        });
                    }
                } catch (_error) {
                    // fallback to local-only context for backward compatibility
                }
                return toToolSuccess({
                    ok: true,
                    data: fallback,
                });
            } catch (error) {
                return toToolError('Failed to load orchestrator context', error instanceof Error ? error.message : String(error));
            }
        });

        mcp.registerTool('orchestrator_submit', ORCHESTRATOR_SUBMIT_TOOL_SCHEMA, async (args) => {
            try {
                const mode = args.mode ?? 'async';
                const metadata = client.getMetadataSnapshot();
                const submitBody = {
                    title: args.title,
                    controllerSessionId: args.controllerSessionId ?? client.sessionId,
                    controllerMachineId: metadata?.machineId ?? undefined,
                    tasks: applyDefaultWorkingDirectory(args.tasks, metadata?.path, metadata?.machineId),
                    maxConcurrency: args.maxConcurrency,
                    idempotencyKey: args.idempotencyKey,
                    metadata: args.metadata,
                    mode: 'async' as const,
                    waitTimeoutMs: args.waitTimeoutMs,
                    pollIntervalMs: args.pollIntervalMs,
                };

                const submit = await client.orchestratorSubmit(submitBody);
                const submitData = submit?.data ?? null;
                if (mode !== 'blocking' || !submitData?.runId) {
                    return toToolSuccess({
                        ok: true,
                        mode,
                        data: submitData,
                    });
                }

                const waitTimeoutMs = Math.max(args.waitTimeoutMs ?? DEFAULT_BLOCKING_WAIT_TIMEOUT_MS, DEFAULT_BLOCKING_WAIT_TIMEOUT_MS);
                const pendTimeoutMs = Math.max(10_000, Math.min(args.pollIntervalMs ?? 60_000, 60_000));
                const blocking = await awaitRunTerminal(submitData.runId, waitTimeoutMs, pendTimeoutMs);

                return toToolSuccess({
                    ok: true,
                    mode: 'blocking',
                    submit: submitData,
                    blocking,
                });
            } catch (error) {
                return toToolError('Failed to submit orchestrator run', error instanceof Error ? error.message : String(error));
            }
        });

        mcp.registerTool('orchestrator_pend', ORCHESTRATOR_PEND_TOOL_SCHEMA, async (args) => {
            const startedAt = Date.now();
            const totalTimeoutMs = Math.max(args.timeoutMs ?? 10 * 60 * 1000, 10 * 60 * 1000);
            let cursor = args.cursor;

            while (true) {
                const elapsed = Date.now() - startedAt;
                const remaining = totalTimeoutMs - elapsed;
                if (remaining <= 0) break;

                try {
                    const response = await client.orchestratorPend(args.runId, {
                        cursor,
                        waitFor: args.waitFor,
                        timeoutMs: Math.min(remaining, 120_000),
                        include: args.include,
                    });
                    return toToolSuccess(response);
                } catch (error: any) {
                    const status = error?.response?.status;
                    if (status === 504 && remaining > 1000) {
                        cursor = undefined; // Reset cursor on 504 and retry
                        continue;
                    }
                    return toToolError('Failed to pend orchestrator run', error instanceof Error ? error.message : String(error));
                }
            }

            // Timeout exhausted — do a final non-blocking fetch
            try {
                const response = await client.orchestratorPend(args.runId, {
                    cursor,
                    waitFor: args.waitFor,
                    timeoutMs: 0,
                    include: args.include,
                });
                return toToolSuccess(response);
            } catch (error) {
                return toToolError('Failed to pend orchestrator run', error instanceof Error ? error.message : String(error));
            }
        });

        mcp.registerTool('orchestrator_list', ORCHESTRATOR_LIST_TOOL_SCHEMA, async (args) => {
            try {
                const response = await client.orchestratorListRuns({
                    status: args.status,
                    limit: args.limit,
                    cursor: args.cursor,
                });
                return toToolSuccess(response);
            } catch (error) {
                return toToolError('Failed to list orchestrator runs', error instanceof Error ? error.message : String(error));
            }
        });

        mcp.registerTool('orchestrator_cancel', ORCHESTRATOR_CANCEL_TOOL_SCHEMA, async (args) => {
            try {
                const response = await client.orchestratorCancel(args.runId, { reason: args.reason });
                return toToolSuccess(response);
            } catch (error) {
                return toToolError('Failed to cancel orchestrator run', error instanceof Error ? error.message : String(error));
            }
        });

        mcp.registerTool('orchestrator_send_message', ORCHESTRATOR_SEND_MESSAGE_TOOL_SCHEMA, async (args) => {
            try {
                const response = await client.orchestratorSendMessage({
                    taskId: args.taskId,
                    message: args.message,
                });
                return toToolSuccess(response);
            } catch (error) {
                return toToolError('Failed to send message to orchestrator task', error instanceof Error ? error.message : String(error));
            }
        });
    }

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient) {
    // Store transports by session ID to support multiple Claude Code connections
    // This is needed when switching between local and remote modes, as each mode
    // spawns a new Claude Code process that needs its own MCP session
    const transports: Map<string, StreamableHTTPServerTransport> = new Map();
    const enableOrchestratorTools = shouldEnableOrchestratorTools();
    const toolNames = enableOrchestratorTools
        ? ['change_title', 'preview_html', 'orchestrator_get_context', 'orchestrator_submit', 'orchestrator_pend', 'orchestrator_list', 'orchestrator_cancel', 'orchestrator_send_message']
        : ['change_title', 'preview_html'];

    // Capture console.error from Hono to our logger
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
        logger.debug("[happyMCP] console.error:", ...args);
        originalConsoleError.apply(console, args);
    };

    //
    // Create the HTTP server with multi-session support
    //
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        logger.debug("[happyMCP] Received request:", req.method, req.url, "sessionId:", sessionId);

        try {
            // For POST requests, we need to read the body to check if it's an initialize request
            if (req.method === 'POST') {
                const body = await readRequestBody(req);
                const parsedBody = JSON.parse(body);

                let transport: StreamableHTTPServerTransport;

                if (sessionId && transports.has(sessionId)) {
                    // Reuse existing transport for this session
                    transport = transports.get(sessionId)!;
                    logger.debug("[happyMCP] Reusing transport for session:", sessionId);
                } else if (!sessionId && isInitializeRequest(parsedBody)) {
                    // New initialization request - create new transport and MCP server
                    logger.debug("[happyMCP] New initialize request, creating transport");

                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: (newSessionId: string) => {
                            logger.debug("[happyMCP] Session initialized:", newSessionId);
                            transports.set(newSessionId, transport);
                        }
                    });

                    // Set up cleanup when transport closes
                    transport.onclose = () => {
                        const sid = transport.sessionId;
                        if (sid && transports.has(sid)) {
                            logger.debug("[happyMCP] Transport closed, removing session:", sid);
                            transports.delete(sid);
                        }
                    };

                    transport.onerror = (error: Error) => {
                        logger.debug("[happyMCP] Transport error:", error);
                    };

                    // Create and connect MCP server to this transport
                    const mcp = createMcpServer(client, { enableOrchestratorTools });
                    await mcp.connect(transport);

                    // Handle the request with the parsed body
                    await transport.handleRequest(req, res, parsedBody);
                    logger.debug("[happyMCP] Initialize request handled successfully");
                    return;
                } else {
                    // Invalid request - no session ID and not an initialize request
                    logger.debug("[happyMCP] Bad request: no session ID and not initialize");
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Bad Request: No valid session ID provided'
                        },
                        id: null
                    }));
                    return;
                }

                // Handle the request with existing transport
                await transport.handleRequest(req, res, parsedBody);
                logger.debug("[happyMCP] Request handled successfully");
            } else if (req.method === 'GET' || req.method === 'DELETE') {
                // GET (SSE) and DELETE requests require a session ID
                if (!sessionId || !transports.has(sessionId)) {
                    logger.debug("[happyMCP] Bad request: invalid session for GET/DELETE");
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Invalid or missing session ID');
                    return;
                }

                const transport = transports.get(sessionId)!;
                await transport.handleRequest(req, res);
                logger.debug("[happyMCP] GET/DELETE request handled successfully");
            } else {
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                res.end('Method not allowed');
            }
        } catch (error) {
            logger.debug("[happyMCP] Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug("[happyMCP] Server started at:", baseUrl.toString());

    return {
        url: baseUrl.toString(),
        toolNames,
        stop: async () => {
            logger.debug('[happyMCP] Stopping server');
            // Close all active transports
            for (const [sessionId, transport] of transports) {
                logger.debug('[happyMCP] Closing transport for session:', sessionId);
                try {
                    await transport.close();
                } catch (error) {
                    logger.debug('[happyMCP] Error closing transport:', error);
                }
            }
            transports.clear();
            server.close();
        }
    }
}

// Helper function to read request body
function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
