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
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

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
        let mcp: McpServer | undefined;
        let transport: StreamableHTTPServerTransport | undefined;
        try {
            // StreamableHTTPServerTransport in stateless mode must not be reused
            // across requests. Create a fresh transport per request. Also create a
            // fresh MCP server instance per request because a connected Protocol
            // cannot be re-connected to another transport.
            transport = new StreamableHTTPServerTransport({
                // NOTE: Returning session id here will result in claude
                // sdk spawn to fail with `Invalid Request: Server already initialized`
                sessionIdGenerator: undefined
            });
            mcp = createMcpServer();
            await mcp.connect(transport);

            let parsedBody: unknown = undefined;
            if (req.method === 'POST') {
                const chunks: Buffer[] = [];
                for await (const chunk of req) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                const rawBody = Buffer.concat(chunks).toString('utf8');
                if (rawBody.length > 0) {
                    parsedBody = JSON.parse(rawBody);
                }
            }

            res.on('close', () => {
                transport?.close().catch(() => { });
                mcp?.close();
            });

            await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
            logger.debug("Error handling request:", error);
            try {
                await transport?.close();
            } catch { }
            mcp?.close();
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

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title'],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            mcp.close();
            server.close();
        }
    }
}
