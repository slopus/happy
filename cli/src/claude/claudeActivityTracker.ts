import { startHTTPDirectProxy } from "@/modules/proxy/startHTTPDirectProxy";
import { logger } from "@/ui/logger";

export async function startClaudeActivityTracker(onThinking: (thinking: boolean) => void) {

    let requestCounter = 0;
    const activeRequests = new Map<number, NodeJS.Timeout>(); // Map to track request timeouts
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    let isThinking = false;
    
    // Request timeout duration (5 minutes)
    const REQUEST_TIMEOUT = 5 * 60 * 1000;
    
    // Helper function to check if we should stop thinking
    const checkAndStopThinking = () => {
        if (activeRequests.size === 0 && isThinking && !stopThinkingTimeout) {
            // All requests completed, stop thinking after a delay
            stopThinkingTimeout = setTimeout(() => {
                if (isThinking && activeRequests.size === 0) {
                    isThinking = false;
                    logger.debug(`[ClaudeActivityTracker] Thinking stopped`);
                    onThinking(false);
                }
                stopThinkingTimeout = null;
            }, 500); // 500ms delay before stopping
        }
    };

    const proxyUrl = await startHTTPDirectProxy({
        target: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        onRequest: (req, proxyReq) => {
            if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
                const requestId = ++requestCounter;
                (req as any)._requestId = requestId;

                // Clear any pending stop timeout
                if (stopThinkingTimeout) {
                    clearTimeout(stopThinkingTimeout);
                    stopThinkingTimeout = null;
                }

                // Set up timeout for this request
                const timeout = setTimeout(() => {
                    logger.debug(`[ClaudeActivityTracker] Request ${requestId} timed out after ${REQUEST_TIMEOUT}ms`);
                    activeRequests.delete(requestId);
                    checkAndStopThinking();
                }, REQUEST_TIMEOUT);
                
                activeRequests.set(requestId, timeout);

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
                
                // Clear the timeout for this request
                const timeout = activeRequests.get(requestId);
                if (timeout) {
                    clearTimeout(timeout);
                }
                
                let cleaned = false;
                const cleanupRequest = () => {
                    if (!cleaned) {
                        cleaned = true;
                        activeRequests.delete(requestId);
                        logger.debug(`[ClaudeActivityTracker] Request ${requestId} completed, ${activeRequests.size} active requests remaining`);
                        checkAndStopThinking();
                    }
                };

                // Handle normal completion
                proxyRes.on('end', cleanupRequest);
                
                // Handle errors
                proxyRes.on('error', (err) => {
                    logger.debug(`[ClaudeActivityTracker] Request ${requestId} error: ${err.message}`);
                    cleanupRequest();
                });
                
                // Handle aborted responses
                proxyRes.on('aborted', () => {
                    logger.debug(`[ClaudeActivityTracker] Request ${requestId} aborted`);
                    cleanupRequest();
                });
                
                // Handle close events (covers edge cases)
                proxyRes.on('close', () => {
                    cleanupRequest();
                });
            }
        }
    });
    return proxyUrl;
}