import { startHTTPDirectProxy } from "@/modules/proxy/startHTTPDirectProxy";
import { logger } from "@/ui/logger";

export async function startClaudeActivityTracker(onThinking: (thinking: boolean) => void) {

    let requestCounter = 0;
    const activeRequests = new Set<number>();
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    let isThinking = false;

    const proxyUrl = await startHTTPDirectProxy({
        target: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        onRequest: (req, proxyReq) => {
            if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
                const requestId = ++requestCounter;
                activeRequests.add(requestId);
                (req as any)._requestId = requestId;

                // Clear any pending stop timeout
                if (stopThinkingTimeout) {
                    clearTimeout(stopThinkingTimeout);
                    stopThinkingTimeout = null;
                }

                // Start thinking only if not already thinking
                if (!isThinking) {
                    logger.debug(`[ClaudeActivityTracker] Thinking started`);
                    isThinking = true;
                    onThinking(true);
                }
            }
        },
        onResponse: (req, proxyRes) => {
            if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
                const requestId = (req as any)._requestId;

                proxyRes.on('end', () => {
                    activeRequests.delete(requestId);

                    if (activeRequests.size === 0 && isThinking && !stopThinkingTimeout) {
                        // All requests completed, stop thinking after a delay
                        stopThinkingTimeout = setTimeout(() => {
                            if (isThinking) {
                                isThinking = false;
                                logger.debug(`[ClaudeActivityTracker] Thinking stopped`);
                                onThinking(false);
                            }
                        }, 500); // 500ms delay before stopping
                    }
                });

                proxyRes.on('error', () => {
                    activeRequests.delete(requestId);

                    if (activeRequests.size === 0 && isThinking && !stopThinkingTimeout) {
                        // Stop thinking after delay if no more requests
                        stopThinkingTimeout = setTimeout(() => {
                            if (isThinking) {
                                isThinking = false;
                                logger.debug(`[ClaudeActivityTracker] Thinking stopped`);
                                onThinking(false);
                            }
                        }, 500);
                    }
                });
            }
        }
    });
    return proxyUrl;
}