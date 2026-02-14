/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";

export async function startHappyServer(client: ApiSessionClient) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
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

    //
    // Build a fresh MCP server per HTTP request.
    //
    // We intentionally run in stateless mode (no session IDs) because some
    // clients re-send initialize and do not keep MCP session headers.
    // In recent MCP SDK versions, stateless transports are single-use; reusing
    // one transport across requests now throws and surfaces as
    // "Error POSTing to endpoint" on clients.
    //
    const createMcpServer = () => {
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

        return mcp;
    };

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined
        });

        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;

            try {
                await transport.close();
            } catch (error) {
                logger.debug('[happyMCP] Error closing transport:', error);
            }

            try {
                await mcp.close();
            } catch (error) {
                logger.debug('[happyMCP] Error closing server:', error);
            }
        };

        res.once('close', () => {
            cleanup().catch((error) => {
                logger.debug('[happyMCP] Error during request cleanup:', error);
            });
        });

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug('[happyMCP] Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            await cleanup();
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
            server.close();
        }
    }
}
