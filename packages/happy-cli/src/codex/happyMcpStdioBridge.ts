/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing first-party Happy tools.
 * On invocation it forwards tool calls to an existing Happy HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { registerHappyBridgeTools } from './happyMcpBridgeTools';
import { withHappyMcpSchemaProfile, type HappyMcpSchemaProfile } from './happyMcpSchemaProfile';

function parseArgs(argv: string[]): { url: string | null; schemaProfile?: HappyMcpSchemaProfile } {
  let url: string | null = null;
  let schemaProfile: HappyMcpSchemaProfile | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    } else if (a === '--schema-profile' || a.startsWith('--schema-profile=')) {
      const value = a === '--schema-profile' ? argv[++i] : a.slice('--schema-profile='.length);
      if (value !== 'antigravity') throw new Error('Unknown or missing MCP schema profile');
      schemaProfile = value;
    }
  }
  return { url, schemaProfile };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs, schemaProfile } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  const server = new McpServer({
    name: 'Happy MCP Bridge',
    version: '1.0.0',
  });
  let httpClient: Client | null = null;
  let httpConnection: Promise<Client> | null = null;
  let stopping = false;
  let shutdown: Promise<void> | undefined;

  function stopWithOwner(): Promise<void> {
    if (shutdown) return shutdown;
    stopping = true;
    process.stdin.off('end', onOwnerClosed);
    process.stdin.off('close', onOwnerClosed);
    // A stalled transport close must not leave this ownerless bridge alive.
    // This single deadline only exits this dedicated stdio process.
    const deadline = setTimeout(() => process.exit(0), 2_000);
    deadline.unref();
    shutdown = Promise.allSettled([
      Promise.resolve().then(() => httpClient?.close()),
      Promise.resolve().then(() => server.close()),
    ]).then(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
    return shutdown;
  }
  function onOwnerClosed() { void stopWithOwner(); }

  // Install before connecting stdio so EOF during initialization is owned too.
  process.stdin.once('end', onOwnerClosed);
  process.stdin.once('close', onOwnerClosed);

  async function ensureHttpClient(): Promise<Client> {
    if (stopping) throw new Error('Happy MCP bridge owner has closed');
    if (httpConnection) return httpConnection;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    // Retain ownership before the first await: EOF must abort in-flight HTTP
    // initialization, and concurrent tool calls must share this one client.
    httpClient = client;
    httpConnection = client.connect(transport).then(async () => {
      if (stopping) {
        await client.close();
        throw new Error('Happy MCP bridge owner has closed');
      }
      return client;
    }).catch(async error => {
      await client.close().catch(() => {});
      if (httpClient === client) { httpClient = null; httpConnection = null; }
      throw error;
    });
    return httpConnection;
  }

  registerHappyBridgeTools(server, ensureHttpClient);

  // Start STDIO transport
  if (process.stdin.readableEnded || process.stdin.destroyed) return stopWithOwner();
  const stdio = new StdioServerTransport();
  await server.connect(withHappyMcpSchemaProfile(stdio, schemaProfile));
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
