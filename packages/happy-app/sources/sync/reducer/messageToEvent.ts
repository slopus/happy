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
 * Tool names that should be converted to events instead of showing as permission dialogs.
 * Used by Phase 0 (AgentState permissions) to skip creating tool messages for these tools.
 */
const EVENT_TOOL_NAMES = new Set([
    'mcp:happy:change_title',
    'mcp__happy__change_title',
]);

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
            if (content.type === 'tool-call' && EVENT_TOOL_NAMES.has(content.name)) {
                const title = content.input?.title;
                if (typeof title === 'string') {
                    return {
                        type: 'message',
                        message: `Title changed to "${title}"`,
                    } as AgentEvent;
                }
            }

            // Hide ToolSearch calls that are only for loading change_title tool
            if (content.type === 'tool-call' && content.name === 'ToolSearch') {
                const query = content.input?.query;
                if (typeof query === 'string' && (query.includes('change_title') || query.includes('preview_html'))) {
                    return {
                        type: 'hidden',
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

/**
 * Checks if a permission request for a given tool should be suppressed
 * because parseMessageAsEvent will convert it to an event instead.
 */
export function shouldSuppressPermission(toolName: string, args: any): boolean {
    if (!EVENT_TOOL_NAMES.has(toolName)) return false;
    // change_title needs a title to be converted to event
    if (typeof args?.title === 'string') return true;
    return false;
}