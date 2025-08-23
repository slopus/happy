/**
 * Title generator for chat sessions
 * Handles generating descriptive chat titles based on user messages
 * Used by both local and remote launchers
 */

import { query } from '@anthropic-ai/claude-code';
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export class TitleGenerator {
    private isFirstMessage = true;
    private needsNewSummary = false;
    
    /**
     * Trigger title generation when needed (first message or after reset)
     * This should be called whenever a user sends a message
     */
    async onUserMessage(
        userMessage: string,
        sessionPath: string,
        client: ApiSessionClient
    ) {
        // if (this.isFirstMessage || this.needsNewSummary) {
        //     logger.debug('[TitleGenerator] Triggering async chat name generation');
            
        //     // Fire and forget - don't await to avoid blocking main flow
        //     this.generateChatNameAsync(
        //         userMessage,
        //         sessionPath,
        //         client,
        //         randomUUID() // Generate UUID for summary leafUuid
        //     ).catch(err => logger.debug('[TitleGenerator] Failed:', err));
            
        //     this.isFirstMessage = false;
        //     this.needsNewSummary = false;
        // }
    }
    
    /**
     * Mark that a new summary is needed (after context reset)
     * Call this when session is reset with /clear command
     */
    onSessionReset() {
        logger.debug('[TitleGenerator] Session reset - will generate new title on next message');
        this.needsNewSummary = true;
    }
    
    /**
     * Asynchronously generate a chat name using direct SDK
     * Uses XML tags for reliable parsing of generated titles
     */
    private async generateChatNameAsync(
        userMessage: string,
        sessionPath: string,
        client: ApiSessionClient,
        leafUuid: string
    ) {
        try {
            logger.debug('[TitleGenerator] Starting generation for message:', userMessage.substring(0, 100) + '...');
            
            // Use direct SDK query with XML tags for parsing
            const response = query({
                prompt: `Generate a 2-4 word title for a conversation that starts with: "${userMessage}". 
                         Put the title inside XML tags like this: <title>Your Title Here</title>
                         Reply with ONLY the XML tags and title, nothing else.`,
                options: {
                    cwd: sessionPath,
                    allowedTools: ['invalid_tool'],
                    maxTurns: 1
                }
            });
            
            // Wait for the result event
            for await (const message of response) {
                if (message.type === 'result' && message.subtype === 'success') {
                    // Parse title from XML tags
                    const titleMatch = message.result.match(/<title>(.*?)<\/title>/);
                    if (titleMatch && titleMatch[1]) {
                        const generatedTitle = titleMatch[1].trim().substring(0, 60);
                        logger.debug('[TitleGenerator] Generated title:', generatedTitle);
                        
                        // Send as summary message
                        client.sendClaudeSessionMessage({
                            type: 'summary',
                            summary: generatedTitle,
                            leafUuid: leafUuid
                        });
                    }
                    break;
                }
            }
        } catch (error) {
            logger.debug('[TitleGenerator] Failed to generate chat name:', error);
            // Fail silently - don't interrupt main flow
        }
    }
}