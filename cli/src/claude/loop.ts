/**
 * Claude loop - processes user messages in batches
 * 
 * This module implements the main processing loop that:
 * 1. Waits for user messages from the session
 * 2. Batches messages received within a short time window
 * 3. Processes them with Claude
 * 4. Sends responses back through the session
 */

import { ApiSessionClient } from "@/api/apiSession";
import { Claude } from "./claude";
import { UserMessage } from "@/api/types";
import { logger } from "@/ui/logger";

export function startClaudeLoop(opts: {
    path: string
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
}, session: ApiSessionClient) {

    let exiting = false;
    let sessionId: string | undefined;
    
    // Message queue and processing state
    const messageQueue: UserMessage[] = [];
    let messageResolve: (() => void) | null = null;
    
    // Create claude instance
    const claude = new Claude();
    
    // We'll set up event handlers per-turn inside the loop
    
    // Handle incoming messages
    session.onUserMessage((message) => {
        messageQueue.push(message);
        // Wake up the loop if it's waiting
        if (messageResolve) {
            messageResolve();
            messageResolve = null;
        }
    });
    
    // Main processing loop
    const promise = (async () => {
        while (!exiting) {
            // Wait for messages if queue is empty
            if (messageQueue.length === 0) {
                await new Promise<void>((resolve) => {
                    messageResolve = resolve;
                    // Check again in case message arrived before we set resolver
                    if (messageQueue.length > 0) {
                        resolve();
                        messageResolve = null;
                    }
                });
            }
            
            // Exit check after waiting
            if (exiting) break;
            
            // Batch collection: wait a short time to collect multiple messages
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Process all accumulated messages
            if (messageQueue.length > 0) {
                // Get all messages and clear queue
                const messages = messageQueue.splice(0, messageQueue.length);
                
                // Combine all messages into one
                const combinedText = messages
                    .map(msg => msg.content.text)
                    .join('\n\n');
                
                logger.info(`Processing ${messages.length} message(s)`);
                
                try {
                    // Process with Claude
                    await new Promise<void>((resolve, reject) => {
                        let hasExited = false;
                        
                        // Set up response handler for this turn
                        const handleResponse = (response: any) => {
                            logger.debug('Claude response:', response);
                            
                            // Capture session ID for subsequent runs
                            if (response.session_id) {
                                sessionId = response.session_id;
                            }
                            
                            // Send response back to session
                            session.sendMessage(response);
                        };
                        
                        const handleExit = () => {
                            if (!hasExited) {
                                hasExited = true;
                                // Clean up listeners
                                claude.off('response', handleResponse);
                                claude.off('error', handleError);
                                claude.off('processError', handleProcessError);
                                claude.off('exit', handleExit);
                                resolve();
                            }
                        };
                        
                        const handleError = (error: string) => {
                            logger.error('Claude error:', error);
                            session.sendMessage({
                                type: 'error',
                                error: error
                            });
                        };
                        
                        const handleProcessError = (error: Error) => {
                            if (!hasExited) {
                                hasExited = true;
                                // Clean up listeners
                                claude.off('response', handleResponse);
                                claude.off('error', handleError);
                                claude.off('processError', handleProcessError);
                                claude.off('exit', handleExit);
                                reject(error);
                            }
                        };
                        
                        // Set up listeners for this turn
                        claude.on('response', handleResponse);
                        claude.on('error', handleError);
                        claude.on('processError', handleProcessError);
                        claude.on('exit', handleExit);
                        
                        // Run Claude with combined input
                        claude.runClaudeCodeTurn(
                            combinedText,
                            sessionId,
                            {
                                workingDirectory: opts.path,
                                model: opts.model,
                                permissionMode: opts.permissionMode || 'auto',
                            }
                        );
                    });
                    
                } catch (error) {
                    logger.error('Error processing messages:', error);
                    session.sendMessage({
                        type: 'error',
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            }
        }
        
        // Cleanup
        claude.kill();
    })();

    return async () => {
        exiting = true;
        // Wake up the loop if it's waiting
        if (messageResolve) {
            messageResolve();
        }
        await promise;
    };
}