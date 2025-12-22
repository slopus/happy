/**
 * Dedicated HTTP server for receiving Claude session hooks
 * 
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 * 
 * Separate from the MCP server to keep concerns isolated.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { logger } from '@/ui/logger';

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    [key: string]: unknown;
}

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Stop the server */
    stop: () => void;
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks
 * 
 * @param options - Server options including the session hook callback
 * @returns Promise resolving to the server instance with port info
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook } = options;

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Only handle POST to /hook/session-start
            if (req.method === 'POST' && req.url === '/hook/session-start') {
                // Set timeout to prevent hanging if Claude doesn't close stdin
                const timeout = setTimeout(() => {
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Request timeout');
                        res.writeHead(408).end('timeout');
                    }
                }, 5000);

                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(chunk as Buffer);
                    }
                    clearTimeout(timeout);
                    
                    const body = Buffer.concat(chunks).toString('utf-8');
                    logger.debug('[hookServer] Received session hook:', body);

                    let data: SessionHookData = {};
                    try {
                        data = JSON.parse(body);
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse hook data as JSON:', parseError);
                    }

                    // Support both snake_case (from Claude) and camelCase
                    const sessionId = data.session_id || data.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                        onSessionHook(sessionId, data);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                    }

                    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                } catch (error) {
                    clearTimeout(timeout);
                    logger.debug('[hookServer] Error handling session hook:', error);
                    if (!res.headersSent) {
                        res.writeHead(500).end('error');
                    }
                }
                return;
            }

            // 404 for anything else
            res.writeHead(404).end('not found');
        });

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);

            resolve({
                port,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error:', err);
            reject(err);
        });
    });
}

