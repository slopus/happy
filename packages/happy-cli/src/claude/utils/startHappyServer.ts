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

// Factory function to create MCP server with tools
function createMcpServer(client: ApiSessionClient): McpServer {
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

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient) {
    // Store transports by session ID to support multiple Claude Code connections
    // This is needed when switching between local and remote modes, as each mode
    // spawns a new Claude Code process that needs its own MCP session
    const transports: Map<string, StreamableHTTPServerTransport> = new Map();

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
                    const mcp = createMcpServer(client);
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
        toolNames: ['change_title', 'preview_html'],
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
