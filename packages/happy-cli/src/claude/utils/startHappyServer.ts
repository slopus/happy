/**
 * Happy MCP server
 * Provides Happy CLI specific tools: chat title management plus session control
 * (open a new session, archive a session) so a running agent can do
 * programmatically what the mobile/web client UI does.
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { ApiClient } from "@/api/api";
import { spawnDaemonSession, stopDaemonSession } from "@/daemon/controlClient";
import { createWorktree } from "@/utils/createWorktree";
import { randomUUID } from "node:crypto";

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

function toolResult(text: string, isError = false): ToolResult {
    return { content: [{ type: 'text', text }], isError };
}

export interface HappyServerDeps {
    /** Account-scoped API client, used by archive_session to mark a session inactive on the server. */
    api?: ApiClient;
}

function createMcpServer(client: ApiSessionClient, deps: HappyServerDeps): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        logger.debug('[happyMCP] Changing title to:', args.title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: args.title,
                leafUuid: randomUUID(),
            });
            return toolResult(`Successfully changed chat title to: "${args.title}"`);
        } catch (error) {
            return toolResult(`Failed to change chat title: ${error instanceof Error ? error.message : String(error)}`, true);
        }
    });

    mcp.registerTool('open_session', {
        description: 'Open a new Happy session (a separate agent process) on this machine — the programmatic equivalent of the client UI\'s "new session". Optionally create an isolated git worktree first and open the session inside it. Returns the new session id.',
        title: 'Open Happy Session',
        inputSchema: {
            directory: z.string().optional().describe("Absolute path to open the session in. Defaults to the current session's working directory."),
            agent: z.enum(['claude', 'codex', 'gemini', 'openclaw']).optional().describe('Which agent to launch (default: claude).'),
            worktree: z.boolean().optional().describe('If true, create a new git worktree under <directory>/.dev/worktree/<name> and open the session there. <directory> must be inside a git repo.'),
        },
    }, async (args) => {
        try {
            let directory = args.directory || client.getMetadata()?.path || process.cwd();
            let worktreeNote = '';
            if (args.worktree) {
                const worktree = await createWorktree(directory);
                directory = worktree.worktreePath;
                worktreeNote = ` (new worktree on branch '${worktree.branchName}')`;
            }
            const result = await spawnDaemonSession(directory, undefined, {
                agent: args.agent,
                // Stamp lineage so the new session knows its parent (used by the
                // app's fork-lineage view). HAPPY_FORKED_FROM_SESSION_ID only sets
                // metadata.parentSessionId — it does not backfill history.
                environmentVariables: { HAPPY_FORKED_FROM_SESSION_ID: client.sessionId },
            });
            if (result?.error) {
                return toolResult(`Failed to open session: ${result.error}`, true);
            }
            if (!result?.success || !result?.sessionId) {
                return toolResult(`Failed to open session: ${JSON.stringify(result)}`, true);
            }
            return toolResult(`Opened new ${args.agent ?? 'claude'} session ${result.sessionId} in ${directory}${worktreeNote}.`);
        } catch (error) {
            return toolResult(`Failed to open session: ${error instanceof Error ? error.message : String(error)}`, true);
        }
    });

    mcp.registerTool('archive_session', {
        description: 'Archive a Happy session by id — the programmatic equivalent of the client UI\'s "Archive". Stops the live process via the local daemon (so the archive sticks past the session keepalive) and marks the session inactive on the server. The session stays resumable. Cannot archive the current session from within itself.',
        title: 'Archive Happy Session',
        inputSchema: {
            sessionId: z.string().describe('The Happy session id to archive.'),
        },
    }, async (args) => {
        if (args.sessionId === client.sessionId) {
            return toolResult('Cannot archive the current session from within itself — its keepalive would immediately re-activate it. Exit the session instead.', true);
        }
        try {
            const stopped = await stopDaemonSession(args.sessionId);
            let archived = false;
            if (deps.api) {
                archived = await deps.api.deactivateSession(args.sessionId);
            }
            const notes: string[] = [];
            notes.push(stopped ? 'process stopped via daemon' : 'process not tracked by the local daemon (already stopped, or running on another machine)');
            notes.push(deps.api ? (archived ? 'marked inactive on server' : 'server archive request failed') : 'server archive unavailable');
            const ok = stopped || archived;
            const tail = (!stopped && archived) ? ' Note: if the session is still live elsewhere, its keepalive may re-activate it.' : '';
            return toolResult(`archive_session ${args.sessionId}: ${notes.join('; ')}.${tail}`, !ok);
        } catch (error) {
            return toolResult(`Failed to archive session: ${error instanceof Error ? error.message : String(error)}`, true);
        }
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient, deps: HappyServerDeps = {}) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(client, deps);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', 'open_session', 'archive_session'],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}
