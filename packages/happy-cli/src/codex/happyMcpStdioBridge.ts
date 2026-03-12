/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing Happy tools (`change_title`, `preview_html`).
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
import { z } from 'zod';

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

  // Helper to register a tool that forwards calls to the HTTP MCP server
  function registerForwardedTool(
    name: string,
    opts: { description: string; title: string; inputSchema: Record<string, z.ZodType> },
  ) {
    server.registerTool(name, opts, async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name, arguments: args });
        return response as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to call ${name}: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    });
  }

  registerForwardedTool('change_title', {
    description: 'Change the title of the current chat session',
    title: 'Change Chat Title',
    inputSchema: {
      title: z.string().describe('The new title for the chat session'),
    },
  });

  registerForwardedTool('preview_html', {
    description: 'Preview an HTML page in the client app. The HTML must be a complete, self-contained document with all CSS and JS inlined.',
    title: 'Preview HTML',
    inputSchema: {
      html: z.string().describe('Complete self-contained HTML document string'),
      title: z.string().optional().describe('Display title for the preview'),
    },
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

