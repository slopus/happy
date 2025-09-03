/**
 * Message to Event Parser
 * 
 * This module provides functionality to parse certain messages and convert them
 * to events. Messages that match specific patterns can be transformed into events
 * which will skip normal message processing phases and be handled as events instead.
 */

import { NormalizedMessage } from "../typesRaw";
import { AgentEvent } from "../typesRaw";

/**
 * Parses a normalized message to determine if it should be converted to an event.
 * 
 * @param msg - The normalized message to parse
 * @returns An AgentEvent if the message should be converted, null otherwise
 * 
 * Examples of messages that could be converted to events:
 * - User messages with special commands (e.g., "/switch mode")
 * - Agent messages with specific tool results
 * - Messages with certain metadata flags
 */
export function parseMessageAsEvent(msg: NormalizedMessage): AgentEvent | null {
    // Skip sidechain messages
    if (msg.isSidechain) {
        return null;
    }

    // Check for agent messages that should become events
    if (msg.role === 'agent') {
        for (const content of msg.content) {
            // Check for Claude AI usage limit messages
            if (content.type === 'text') {
                const limitMatch = content.text.match(/^Claude AI usage limit reached\|(\d+)$/);
                if (limitMatch) {
                    const timestamp = parseInt(limitMatch[1], 10);
                    if (!isNaN(timestamp)) {
                        return {
                            type: 'limit-reached',
                            endsAt: timestamp
                        } as AgentEvent;
                    }
                }
                
            }
            
            // Check for mcp__happy__change_title tool calls
            if (content.type === 'tool-call' && content.name === 'mcp__happy__change_title') {
                const title = content.input?.title;
                if (typeof title === 'string') {
                    return {
                        type: 'message',
                        message: `Title changed to "${title}"`,
                    } as AgentEvent;
                }
            }
        }
    }

    // Additional parsing logic can be added here
    // For example, checking specific metadata patterns or other message types

    // No event conversion needed
    return null;
}

/**
 * Checks if a message should be excluded from normal processing
 * after being converted to an event.
 * 
 * @param msg - The normalized message to check
 * @returns true if the message should skip normal processing
 */
export function shouldSkipNormalProcessing(msg: NormalizedMessage): boolean {
    // If a message converts to an event, it should skip normal processing
    return parseMessageAsEvent(msg) !== null;
}