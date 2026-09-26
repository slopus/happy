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

import { unixMcpFetch } from '@/claude/utils/unixMcpFetch';
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
  const socketPath = process.env.SAYCODE_MCP_SOCKET;
  const baseUrl = socketPath ? 'http://localhost/' : urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';
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
  let httpClientReady: Promise<Client> | null = null;
  let closing = false;

  async function ensureHttpClient(): Promise<Client> {
    if (closing) throw new Error('MCP bridge is closing');
    if (httpClientReady) return httpClientReady;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
      fetch: socketPath ? unixMcpFetch(socketPath, process.env.SAYCODE_MCP_TOKEN ?? '') : undefined,
    });
    // Retain the client before connect: stdin may close during initialization.
    httpClient = client;
    httpClientReady = client.connect(transport).then(() => client).catch(async (error) => {
      await client.close();
      httpClient = null;
      httpClientReady = null;
      throw error;
    });
    return httpClientReady;
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
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // A dead parent must not leave this bridge alive on an HTTP stream or a
    // stalled connection. Only this process and its own transports are closed.
    const deadline = setTimeout(() => {
      process.stderr.write('[happy-mcp] Shutdown timed out\n');
      process.exit(1);
    }, 3000);
    const results = await Promise.allSettled([server.close(), httpClient?.close()]);
    clearTimeout(deadline);
    const failed = results.some(result => result.status === 'rejected');
    if (failed) process.stderr.write('[happy-mcp] Transport shutdown failed\n');
    process.exit(failed ? 1 : 0);
  };
  // StdioServerTransport does not treat stdin EOF as transport closure.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
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
