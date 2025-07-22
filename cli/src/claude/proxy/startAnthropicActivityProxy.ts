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

export async function startAnthropicActivityProxy(
    onClaudeActivity: (activity: 'working' | 'idle') => void
) {
    let activeRequests = 0;
    let requestCounter = 0;
    let idleTimer: NodeJS.Timeout | null = null;
    const maxTimeBeforeIdle = 1000; // 1 second

    const checkIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        
        if (activeRequests === 0) {
            idleTimer = setTimeout(() => {
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
            activeRequests++;
            onClaudeActivity('working');
            logger.debug(`[AnthropicProxy #${requestId}] Anthropic request: ${req.method} ${req.url}`);
        }

        // Collect request body
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        
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
                proxyRes.pipe(res);
                
                proxyRes.on('end', () => {
                    if (isAnthropicRequest) {
                        activeRequests--;
                        logger.debug(`[AnthropicProxy #${requestId}] Request completed`);
                        checkIdle();
                    }
                });
            });

            proxyReq.on('error', (error) => {
                if (isAnthropicRequest) {
                    activeRequests--;
                    checkIdle();
                }
                logger.debug(`[AnthropicProxy #${requestId}] Error:`, error.message);
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
            activeRequests++;
            onClaudeActivity('working');
            logger.debug(`[AnthropicProxy #${requestId}] CONNECT to api.anthropic.com`);
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
                activeRequests--;
                logger.debug(`[AnthropicProxy #${requestId}] CONNECT closed`);
                checkIdle();
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
            server.close();
        }
    };
}