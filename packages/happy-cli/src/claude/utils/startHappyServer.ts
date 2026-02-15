/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management.
 *
 * Uses stateful (session-based) transport: each initialize request creates a new
 * transport+McpServer pair, stored by session ID. Subsequent requests reuse the
 * existing transport for that session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";

/**
 * Creates and registers tools on a fresh McpServer instance.
 * Called once per session (each initialize request starts a new session).
 */
function createMcpServer(client: ApiSessionClient): McpServer {
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
        logger.debug('[happyMCP] Changing title to:', args.title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: args.title,
                leafUuid: randomUUID()
            });
            logger.debug('[happyMCP] Title changed successfully');
            return {
                content: [{ type: 'text' as const, text: `Successfully changed chat title to: "${args.title}"` }],
                isError: false,
            };
        } catch (error) {
            logger.debug('[happyMCP] Title change failed:', error);
            return {
                content: [{ type: 'text' as const, text: `Failed to change chat title: ${String(error)}` }],
                isError: true,
            };
        }
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient) {
    // Session state: maps session IDs to their transport+server pairs
    const sessions: Record<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }> = {};

    async function handleRequest(req: IncomingMessage, res: ServerResponse) {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // Existing session — reuse its transport
        if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].transport.handleRequest(req, res);
            return;
        }

        // New session — create transport + MCP server
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
                logger.debug('[happyMCP] Session initialized:', id);
                sessions[id] = { transport, mcp };
            }
        });
        transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && sessions[sid]) {
                delete sessions[sid];
                logger.debug('[happyMCP] Session closed:', sid);
            }
        };

        const mcp = createMcpServer(client);
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
    }

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await handleRequest(req, res);
        } catch (error) {
            logger.debug('[happyMCP] Error handling request:', error);
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

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title'],
        stop: () => {
            logger.debug('[happyMCP] Stopping server');
            for (const session of Object.values(sessions)) {
                session.mcp.close();
            }
            server.close();
        }
    }
}
