/**
 * Happy MCP bridge tools.
 *
 * Registers first-party Happy MCP tools on the stdio bridge and forwards
 * invocations to the per-session HTTP MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const HAPPY_MCP_BRIDGE_TOOL_NAMES = ['change_title', 'send_image', 'send_file', 'archive_session', 'finance_chart'] as const;

type HappyMcpBridgeToolName = typeof HAPPY_MCP_BRIDGE_TOOL_NAMES[number];

async function forwardHappyToolCall(
  name: HappyMcpBridgeToolName,
  args: Record<string, unknown>,
  ensureHttpClient: () => Promise<Client>,
  failurePrefix: string
): Promise<CallToolResult> {
  try {
    const client = await ensureHttpClient();
    return await client.callTool({ name, arguments: args }) as CallToolResult;
  } catch (error) {
    return {
      content: [
        { type: 'text', text: `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}` },
      ],
      isError: true,
    };
  }
}

export function registerHappyBridgeTools(
  server: McpServer,
  ensureHttpClient: () => Promise<Client>
): void {
  server.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z.string().describe('The new title for the chat session'),
      },
    },
    async (args) => forwardHappyToolCall(
      'change_title',
      { title: args.title },
      ensureHttpClient,
      'Failed to change chat title'
    )
  );

  server.registerTool(
    'send_image',
    {
      description: 'Send a local image file into the current chat so the user sees it inline (works on phone and desktop). Use after generating or editing an image. Provide an absolute path to a PNG/JPEG.',
      title: 'Send Image To Chat',
      inputSchema: {
        path: z.string().describe('Absolute path to the local image file (PNG/JPEG)'),
        prompt: z.string().optional().describe('Prompt used to generate this image. Required for GPT Image 2 gallery records when available.'),
        batchId: z.string().optional().describe('Stable id shared by images from the same generation batch.'),
      },
    },
    async (args) => forwardHappyToolCall(
      'send_image',
      {
        path: args.path,
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(args.batchId ? { batchId: args.batchId } : {}),
      },
      ensureHttpClient,
      'Failed to send image'
    )
  );

  server.registerTool(
    'send_file',
    {
      description: 'Send a locally generated audio or video file into the current chat as a playable media card. Provide an absolute local path.',
      title: 'Send File To Chat',
      inputSchema: {
        path: z.string().describe('Absolute path to the local audio/video file'),
        mimeType: z.string().optional().describe('Optional audio/* or video/* MIME type override'),
      },
    },
    async (args) => forwardHappyToolCall(
      'send_file',
      {
        path: args.path,
        ...(args.mimeType ? { mimeType: args.mimeType } : {}),
      },
      ensureHttpClient,
      'Failed to send file'
    )
  );

  server.registerTool(
    'archive_session',
    {
      description: 'Archive and stop the current Happy chat session. Only use this when the user explicitly asks to archive, close, or end the current session after finishing the task.',
      title: 'Archive Current Chat Session',
      inputSchema: {
        reason: z.string().optional().describe('Optional short reason for archiving the session'),
      },
    },
    async (args) => forwardHappyToolCall(
      'archive_session',
      args.reason ? { reason: args.reason } : {},
      ensureHttpClient,
      'Failed to archive chat session'
    )
  );

  server.registerTool(
    'finance_chart',
    {
      description: 'Fetch real market OHLC chart data for a stock, index, ETF, or crypto symbol and return a Happy finance chart block for chat rendering.',
      title: 'Fetch Finance Chart',
      inputSchema: {
        query: z.string().describe('Stock/index query or symbol, such as 上证指数, 000001.SS, AAPL, or 0700.HK'),
        range: z.enum(['5d', '1mo', '3mo', '6mo', '1y']).optional().describe('Chart range. Defaults to 1mo.'),
        interval: z.enum(['1d']).optional().describe('Chart interval. Defaults to 1d.'),
      },
    },
    async (args) => forwardHappyToolCall(
      'finance_chart',
      {
        query: args.query,
        ...(args.range ? { range: args.range } : {}),
        ...(args.interval ? { interval: args.interval } : {}),
      },
      ensureHttpClient,
      'Failed to fetch finance chart'
    )
  );
}
