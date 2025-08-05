import { startHTTPDirectProxy } from "@/modules/proxy/startHTTPDirectProxy";
import { logger } from "@/ui/logger";

export async function startClaudeActivityTracker(onThinking: (thinking: boolean) => void) {
    logger.debug(`[ClaudeActivityTracker] Starting activity tracker`);

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
                    activeRequests.delete(requestId);
                    checkAndStopThinking();
                }, REQUEST_TIMEOUT);

                activeRequests.set(requestId, timeout);

                // Start thinking only if not already thinking
                if (!isThinking) {
                    isThinking = true;
                    onThinking(true);
                }
            }
        },
        onResponse: (req, proxyRes) => {
            proxyRes.headers['connection'] = 'close';

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
                        checkAndStopThinking();
                    }
                };

                // Handle normal completion
                proxyRes.on('end', () => {
                    cleanupRequest();
                });

                // Handle errors
                proxyRes.on('error', (err) => {
                    cleanupRequest();
                });

                // Handle aborted responses
                proxyRes.on('aborted', () => {
                    cleanupRequest();
                });

                // Handle close events (covers edge cases)
                proxyRes.on('close', () => {
                    cleanupRequest();
                });

                // Fallback: Also listen to the original request's close event
                // This ensures cleanup even if proxy response doesn't emit proper events
                req.on('close', () => {
                    cleanupRequest();
                });
            }
        }
    });

    // Reset function to clear all active requests and reset thinking state
    const reset = () => {

        // Clear all timeouts
        for (const [requestId, timeout] of activeRequests) {
            clearTimeout(timeout);
        }

        // Clear the active requests map
        activeRequests.clear();

        // Cancel any pending stop thinking timeout
        if (stopThinkingTimeout) {
            clearTimeout(stopThinkingTimeout);
            stopThinkingTimeout = null;
        }

        // Reset thinking state
        if (isThinking) {
            isThinking = false;
            onThinking(false);
        }
    };

    return {
        proxyUrl,
        reset
    };
}