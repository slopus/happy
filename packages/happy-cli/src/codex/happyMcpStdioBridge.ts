/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO-to-HTTP MCP bridge. It forwards tools/list and tools/call to
 * an existing HTTP MCP server using StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`. Additional request headers
 * can be supplied as JSON through `HAPPY_HTTP_MCP_HEADERS`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';
  const requestHeaders = process.env.HAPPY_HTTP_MCP_HEADERS
    ? JSON.parse(process.env.HAPPY_HTTP_MCP_HEADERS) as Record<string, string>
    : undefined;

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
    });
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  const server = new Server(
    { name: 'Happy MCP Bridge', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const client = await ensureHttpClient();
    return await client.listTools(request.params) as any;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const client = await ensureHttpClient();
    return await client.callTool(request.params) as any;
  });

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
