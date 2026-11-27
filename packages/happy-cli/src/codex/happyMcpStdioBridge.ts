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

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happy MCP Bridge',
    version: '1.0.0',
  });

  registerHappyBridgeTools(server, ensureHttpClient);

  // Start STDIO transport
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
