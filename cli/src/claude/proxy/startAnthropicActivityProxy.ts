import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { logger } from '@/ui/logger';
import { URL } from 'node:url';

import net from 'node:net';

export interface AnthropicActivityProxy {
    url: string;
    cleanup: () => void;
}

/**
 * @kirill is concerned this might not work well for SSE requests.
 * Kind of surprised it works at all :D
 * 
 * This is also error prone to failed or in some strange way incomplete request
 * This will result in counter never going to 0 and session never being marked as idle
 * 
 * The current proxy is poorly implemented, because claude
 * will actually show we are 'offline' because of the proxy.
 * 
 * Using Antropic api base url env was nicer in this way.
 * 
 * We might also not able to inpect the traffic
 * that is being sent through the proxy easily since its encrypted - TBD verification.
 * 
 * We currently will detect 'thinking' sometimes when it doesn't make sense.
 * For example after aborting, or before 
 */

export async function startAnthropicActivityProxy(
    onClaudeActivity: (activity: 'working' | 'idle') => void
) {
    const requestTimeouts = new Map<number, NodeJS.Timeout>();
    let requestCounter = 0;
    let idleTimer: NodeJS.Timeout | null = null;
    const maxTimeBeforeIdle = 50; // 50ms
    const requestTimeout = 5 * 60 * 1000; // 5 minutes max per request

    const cleanupRequest = (requestId: number, reason: string) => {
        const timeout = requestTimeouts.get(requestId);
        if (timeout) {
            clearTimeout(timeout);
            requestTimeouts.delete(requestId);
            logger.debug(`[AnthropicProxy #${requestId}] Cleaned up (${reason}), active requests: ${requestTimeouts.size}`);
            claudeDidSomeWork();
        }
    };

    const claudeDidSomeWork = () => {
        if (idleTimer) clearTimeout(idleTimer);
        
        if (requestTimeouts.size === 0) {
            idleTimer = setTimeout(() => {
                logger.debug(`[AnthropicProxy] Idle for ${maxTimeBeforeIdle}ms, active requests: ${requestTimeouts.size}`);
                onClaudeActivity('idle');
            }, maxTimeBeforeIdle);
        }
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const requestId = ++requestCounter;
        
        // Check if this is an Anthropic API request
        const isAnthropicRequest = req.headers.host === 'api.anthropic.com' || 
                                   req.url?.includes('anthropic.com');
        
        if (isAnthropicRequest) {
            // Set timeout to clean up stuck requests
            const timeout = setTimeout(() => {
                logger.debug(`[AnthropicProxy #${requestId}] Request timeout after ${requestTimeout}ms`);
                cleanupRequest(requestId, 'timeout');
            }, requestTimeout);
            requestTimeouts.set(requestId, timeout);
            
            onClaudeActivity('working');
            logger.debug(`[AnthropicProxy #${requestId}] Anthropic request: ${req.method} ${req.url}, active requests: ${requestTimeouts.size}`);
        }

        // Collect request body
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => {
            chunks.push(chunk);

            if (isAnthropicRequest) {
                claudeDidSomeWork();
            }
        });
        
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            
            // Parse URL - handle both Anthropic and other requests
            let targetUrl: URL;
            if (isAnthropicRequest) {
                targetUrl = new URL(req.url || '/', 'https://api.anthropic.com');
            } else {
                // For non-Anthropic requests, construct full URL from request
                const protocol = req.headers['x-forwarded-proto'] || 'https';
                const host = req.headers.host || 'localhost';
                targetUrl = new URL(req.url || '/', `${protocol}://${host}`);
            }
            
            // Forward request options
            const options = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method: req.method,
                headers: {
                    ...req.headers,
                    host: targetUrl.hostname,
                }
            };

            // Choose HTTP or HTTPS based on protocol
            const requestMethod = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
            const proxyReq = requestMethod(options, (proxyRes) => {
                // Forward status and headers
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                
                // Pipe response
                // @kirill Is this why SSE requests are working fine?
                proxyRes.pipe(res);
                
                proxyRes.on('end', () => {
                    if (isAnthropicRequest) {
                        cleanupRequest(requestId, 'completed');
                    }
                });
            });

            proxyReq.on('error', (error) => {
                if (isAnthropicRequest) {
                    cleanupRequest(requestId, `error: ${error.message}`);
                } else {
                    logger.debug(`[AnthropicProxy #${requestId}] Error:`, error.message);
                }
                res.writeHead(502);
                res.end('Bad Gateway');
            });

            // Write body and end request
            if (body.length > 0) {
                proxyReq.write(body);
            }
            proxyReq.end();
        });
    });

    // Handle CONNECT for HTTPS
    server.on('connect', (req, clientSocket, head) => {
        const requestId = ++requestCounter;
        const [hostname, port] = req.url?.split(':') || ['', '443'];
        const isAnthropicRequest = hostname === 'api.anthropic.com';
        
        if (isAnthropicRequest) {
            // Set timeout to clean up stuck CONNECT requests
            const timeout = setTimeout(() => {
                logger.debug(`[AnthropicProxy #${requestId}] CONNECT timeout after ${requestTimeout}ms`);
                cleanupRequest(requestId, 'timeout');
            }, requestTimeout);
            requestTimeouts.set(requestId, timeout);
            
            onClaudeActivity('working');
            logger.debug(`[AnthropicProxy #${requestId}] CONNECT to api.anthropic.com, active requests: ${requestTimeouts.size}`);
        }

        // Create connection to target
        const serverSocket = net.connect(parseInt(port) || 443, hostname, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            serverSocket.write(head);
            
            // Bidirectional pipe
            serverSocket.pipe(clientSocket);
            clientSocket.pipe(serverSocket);
        });

        const cleanup = () => {
            if (isAnthropicRequest) {
                cleanupRequest(requestId, 'CONNECT closed');
            }
        };

        serverSocket.on('error', (err) => {
            logger.debug(`[AnthropicProxy #${requestId}] CONNECT error:`, err.message);
            clientSocket.end();
            cleanup();
        });

        clientSocket.on('error', cleanup);
        clientSocket.on('end', cleanup);
        serverSocket.on('end', cleanup);
    });

    // Start server
    const url = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                resolve(`http://127.0.0.1:${addr.port}`);
            }
        });
    });

    logger.debug(`[AnthropicProxy] Started at ${url}`);

    return {
        url,
        cleanup: () => {
            if (idleTimer) clearTimeout(idleTimer);
            
            // Clean up any remaining timeouts
            for (const [requestId, timeout] of requestTimeouts) {
                clearTimeout(timeout);
                logger.debug(`[AnthropicProxy] Cleaning up timeout for request #${requestId}`);
            }
            requestTimeouts.clear();
            
            // Log any stuck requests
            if (requestTimeouts.size > 0) {
                logger.debug(`[AnthropicProxy] Warning: ${requestTimeouts.size} active requests still pending at cleanup:`, Array.from(requestTimeouts.keys()));
            }
            
            server.close();
        }
    };
}