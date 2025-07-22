// NOTE: To allow for longer than 5 minutes 
// CRITICAL: Set custom timeouts BEFORE importing MCP SDK
// import { setGlobalDispatcher, Agent } from 'undici';

// Override the default 5-minute timeout with 27.8 hours
// const globalAgent = new Agent({
//   headersTimeout: 100000000, // 27.8 hours
//   bodyTimeout: 100000000,
//   keepAliveTimeout: 100000000,
//   connectTimeout: 100000000
// });

// setGlobalDispatcher(globalAgent);
// logger.debug('[MCP] Set global undici dispatcher with 27.8 hour timeouts');

// NOW import MCP SDK (order matters!)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";

export async function startPermissionServerV2(handler: (req: { name: string, arguments: any }) => Promise<{ approved: boolean, reason?: string }>) {

    //
    // Create the MCP server
    //

    const mcp = new McpServer({
        name: "Permission Server",
        version: "1.0.0",
        description: "A server that allows you to request permissions from the user",
    });

    mcp.registerTool('ask_permission', {
        description: 'Request permission to execute a tool',
        title: 'Request Permission',
        inputSchema: {
            tool_name: z.string().describe('The tool that needs permission'),
            input: z.any().describe('The arguments for the tool'),
        },
        // outputSchema: {
        //     approved: z.boolean().describe('Whether the tool was approved'),
        //     reason: z.string().describe('The reason for the approval or denial'),
        // },
    }, async (args) => {
        const response = await handler({ name: args.tool_name, arguments: args.input });
        const result = response.approved
            ? { behavior: 'allow', updatedInput: args.input || {} }
            : { behavior: 'deny', message: response.reason || 'Permission denied by user' };
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(result),
                },
            ],
            isError: false,
        };
    })

    const transport = new StreamableHTTPServerTransport({ 
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined 
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    // Configure server timeouts to match undici timeouts
    // const timeout = 100000000; // 27.8 hours
    // server.keepAliveTimeout = timeout;
    // server.headersTimeout = timeout;
    // server.requestTimeout = timeout;
    // server.timeout = timeout;
    // logger.debug('[MCP] HTTP server timeouts set to 27.8 hours');

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolName: 'ask_permission'
    }
}