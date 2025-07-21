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

    // NOTE: For reference, the server is actually 
    // the one timing out. Might be on the createServer layer
    // Tested with npx @modelcontextprotocol/inspector
    //
    // Configure infinite timeouts
    // Setting to 1 second for testing
    // const timeout = 100000000;
    // server.keepAliveTimeout = timeout;
    // server.headersTimeout = timeout;
    // server.requestTimeout = timeout;
    // server.timeout = timeout;

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