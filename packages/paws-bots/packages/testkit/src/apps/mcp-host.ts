import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppEmulator } from "./app-emulator.js";

export type HostedApp = { endpoint: string; token: string; close: () => Promise<void> };

/**
 * Serve an emulator as a remote MCP server over streamable HTTP with a bearer token, the shape of
 * a server a person adds as an MCP connection. Stateless: every POST gets a fresh protocol
 * session, so the product's MCP client sees an ordinary server and nothing pins a process.
 */
export async function hostOverMcp(app: AppEmulator, token: string): Promise<HostedApp> {
  const protocol = () => {
    const server = new Server(
      { name: `${app.kind}-service`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: app.tools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const result = app.call(request.params.name, request.params.arguments ?? {});
      return result.ok
        ? { content: [{ type: "text", text: JSON.stringify(result.data) }] }
        : {
            content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
            isError: true,
          };
    });
    return server;
  };
  const http = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp")
      return void response.writeHead(404).end();
    if (request.headers.authorization !== `Bearer ${token}`)
      return void response
        .writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' })
        .end();
    if (request.method !== "POST") return void response.writeHead(405, { allow: "POST" }).end();
    const server = protocol();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  http.unref();
  const { port } = http.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
