/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import type { SessionEnvelope } from "@slopus/happy-wire";
import { runBashStream } from "./bashStream";
import { getActiveBashStreamCall } from "./bashStreamCallRegistry";

// chat-tool-output-streaming Phase 3 — bash_stream emits its agent-side
// tool name via this constant so per-runner mappers (sessionProtocolMapper
// for Claude, AcpSessionManager for ACP, …) consistently key the call
// registry against the same name.
export const BASH_STREAM_AGENT_TOOL_NAME = 'mcp__happy__bash_stream';

export interface HappyServerHandlers {
    changeTitle: (title: string) => Promise<{ success: boolean; error?: string }>;
    client: ApiSessionClient;
}

function createMcpServer(handlers: HappyServerHandlers): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handlers.changeTitle(args.title);
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

    // chat-tool-output-streaming Phase 3 — bash_stream wraps `bash -c` and
    // forwards stdout/stderr line-by-line via onBashStreamProgress so the
    // chat can tail the output. MVP scope: single-line shell commands (no
    // heredoc, timeouts, cancellation). The system prompt steers the agent
    // to fall back to Claude's built-in Bash for everything outside that.
    mcp.registerTool('bash_stream', {
        description:
            'Run a shell command via `bash -c` and stream stdout/stderr live to the chat UI. Use this for long-running batch commands (npm install, pytest, build, etc.) so the user sees output as it happens. For short read-only commands or anything with heredocs/multiline scripts, prefer the built-in Bash tool.',
        title: 'Bash (streamed)',
        inputSchema: {
            command: z.string().describe('Shell command to execute via `bash -c`'),
            cwd: z.string().optional().describe('Working directory (defaults to the daemon cwd)'),
        },
    }, async (args) => {
        logger.debug(`[bash_stream:tool] invoked command=${String(args.command).slice(0, 100)}`);
        try {
            const result = await runBashStream({
                command: args.command,
                cwd: args.cwd,
                onProgress: (progress) => {
                    const call = getActiveBashStreamCall();
                    logger.debug(`[bash_stream:tool] flush stream=${progress.stream} lines=${progress.lines.length} call=${call ?? '(none)'}`);
                    if (!call) return;
                    // Build the envelope manually instead of calling
                    // happy-wire's createEnvelope: the published
                    // @slopus/happy-wire@^0.1.0 zod schema doesn't yet
                    // know about `tool-call-progress`, and its
                    // `.parse(...)` would throw a ZodError inside this
                    // setTimeout callback. That unhandled exception
                    // bubbles up through StreamLineBuffer.close() and
                    // prevents runBashStream from ever resolving — the
                    // tool then hangs forever from the agent's POV.
                    const envelope: SessionEnvelope = {
                        id: createId(),
                        time: Date.now(),
                        role: 'agent',
                        ev: {
                            t: 'tool-call-progress',
                            call,
                            stream: progress.stream,
                            lines: progress.lines,
                        } as SessionEnvelope['ev'],
                    };
                    try {
                        handlers.client.sendSessionProtocolMessage(envelope);
                    } catch (sendErr) {
                        logger.debug(`[bash_stream:tool] envelope send failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
                    }
                },
            });
            logger.debug(`[bash_stream:tool] done exit=${result.exitCode} stdoutBytes=${result.stdout.length}`);
            const tail = `\n[exit ${result.exitCode}]`;
            return {
                content: [
                    {
                        type: 'text',
                        text: (result.stdout || '') + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '') + tail,
                    },
                ],
                isError: result.exitCode !== 0,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `bash_stream failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const changeTitle = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
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

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer({ changeTitle, client });
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', 'bash_stream'],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}
