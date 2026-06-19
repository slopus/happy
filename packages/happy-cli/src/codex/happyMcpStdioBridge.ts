/**
 * Happy MCP STDIO Bridge
 *
 * STDIO MCP server exposing the Happy tools (change_title, open_session,
 * archive_session). On invocation it forwards each tool call to an existing
 * Happy HTTP MCP server using the StreamableHTTPClientTransport.
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

  // Register tools that mirror the HTTP MCP server
  // (claude/utils/startHappyServer.ts is the source of truth for descriptions +
  // schemas) and forward each call to it. Keep in sync when tools are added there.
  server.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z.string().describe('The new title for the chat session'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        return await client.callTool({ name: 'change_title', arguments: args }) as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'open_session',
    {
      description: 'Open a new Happy session (a separate agent process) on this machine — the programmatic equivalent of the client UI\'s "new session". Optionally create an isolated git worktree first and open the session inside it. Returns the new session id.',
      title: 'Open Happy Session',
      inputSchema: {
        directory: z.string().optional().describe("Absolute path to open the session in. Defaults to the current session's working directory."),
        agent: z.enum(['claude', 'codex', 'gemini', 'openclaw']).optional().describe('Which agent to launch (default: claude).'),
        worktree: z.boolean().optional().describe('If true, create a new git worktree under <directory>/.dev/worktree/<name> and open the session there. <directory> must be inside a git repo.'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        return await client.callTool({ name: 'open_session', arguments: args }) as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to open session: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'archive_session',
    {
      description: 'Archive a Happy session by id — the programmatic equivalent of the client UI\'s "Archive". Stops the live process via the local daemon and marks the session inactive on the server. The session stays resumable. Cannot archive the current session from within itself.',
      title: 'Archive Happy Session',
      inputSchema: {
        sessionId: z.string().describe('The Happy session id to archive.'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        return await client.callTool({ name: 'archive_session', arguments: args }) as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to archive session: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

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

