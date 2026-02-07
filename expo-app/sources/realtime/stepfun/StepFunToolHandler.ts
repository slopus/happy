/**
 * StepFun Tool Handler
 * Converts existing realtimeClientTools to StepFun tool format
 * and handles tool invocations
 */

import { realtimeClientTools } from '../realtimeClientTools';
import { StepFunTool } from './types';

/**
 * Generate StepFun tool definitions from existing tools
 */
export function getStepFunToolDefinitions(): StepFunTool[] {
    return [
        {
            type: 'function',
            function: {
                name: 'messageClaudeCode',
                description: 'Send a message to Claude Code. Use this to forward user instructions or questions to Claude Code. The message will be sent to the active coding session.',
                parameters: {
                    type: 'object',
                    properties: {
                        message: {
                            type: 'string',
                            description: 'The message to send to Claude Code',
                        },
                    },
                    required: ['message'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'processPermissionRequest',
                description: 'Process a permission request from Claude Code. Use this when Claude Code asks for permission to perform an action like running a command or editing a file. You should ask the user for confirmation before calling this.',
                parameters: {
                    type: 'object',
                    properties: {
                        decision: {
                            type: 'string',
                            description: 'The decision to allow or deny the permission request',
                            enum: ['allow', 'deny'],
                        },
                    },
                    required: ['decision'],
                },
            },
        },
    ];
}

/**
 * Execute a tool call and return the result
 */
export async function executeStepFunTool(name: string, args: string): Promise<string> {
    try {
        const parsedArgs = JSON.parse(args);

        if (name === 'messageClaudeCode') {
            return await realtimeClientTools.messageClaudeCode(parsedArgs);
        } else if (name === 'processPermissionRequest') {
            return await realtimeClientTools.processPermissionRequest(parsedArgs);
        } else {
            console.warn('[StepFunToolHandler] Unknown tool:', name);
            return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    } catch (error) {
        console.error('[StepFunToolHandler] Tool execution error:', error);
        return JSON.stringify({ error: String(error) });
    }
}
