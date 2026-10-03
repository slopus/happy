import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readDaemonControlPort } from './browserClient';

/** Provider-neutral request/query/cancel surface. No host approval or command execution. */
export function registerSessionWriteScopeTools(mcp: McpServer, sessionId: string, runTool: (work: () => Promise<CallToolResult>) => Promise<CallToolResult>) {
  mcp.registerTool('session_write_scope', {
    title: 'Request session folder write access',
    description: 'Ask the user to approve a narrow existing folder for this session. Describe the installation without commands, tokens or secrets. The user reviews in the permission area; only the Desktop host can approve. Return after requesting and wait for the user. Query status before retrying any installation; profileApplied=true is access, not installation success. list also discovers support; unsupported means use a project-local option or cancel. Children inherit the folder policy; command completion does not revoke access. Old-process revocation may remain unresolved.',
    inputSchema: { action: z.enum(['request', 'list', 'cancel']), path: z.string().max(2048).optional(),
      description: z.string().max(240).optional(), requestId: z.string().uuid().optional() },
  }, async args => runTool(async () => {
    try {
      const connection = await readDaemonControlPort();
      if (!connection) throw new Error('SESSION_WRITE_SCOPE_UNSUPPORTED');
      const body = args.action === 'request' ? { action: args.action, sessionId, path: args.path, description: args.description }
        : args.action === 'cancel' ? { action: args.action, sessionId, requestId: args.requestId } : { action: args.action, sessionId };
      const response = await fetch(`http://127.0.0.1:${connection.port}/session-write-scope`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.controlSecret}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) throw new Error('SESSION_WRITE_SCOPE_UNSUPPORTED');
      const result = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: !response.ok };
    } catch { return { isError: true, content: [{ type: 'text' as const, text: 'SESSION_WRITE_SCOPE_UNSUPPORTED: choose a project-local installation or cancel. No access was approved.' }] }; }
  }));
}
