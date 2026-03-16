/**
 * Translates the realtimeClientTools definitions into OpenAI Realtime
 * function-calling format. The tool *handlers* stay in realtimeClientTools.ts
 * unchanged — this only produces the schema the model sees.
 */

export interface OpenAIToolDef {
    type: 'function';
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, { type: string; description: string }>;
        required: string[];
    };
}

/**
 * Static tool schemas matching the Zod schemas in realtimeClientTools.ts.
 * If a tool is added/changed there, update here too.
 */
export const OPENAI_TOOL_DEFINITIONS: OpenAIToolDef[] = [
    {
        type: 'function',
        name: 'messageClaudeCode',
        description: "Send a message to Claude Code. You MUST specify the 'session' parameter with the project folder name (e.g. 'trading-bot', 'family-journal'). Always ask the user to clarify which session if unclear.",
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The message to send to Claude Code' },
                session: { type: 'string', description: "Target session name (folder name like 'trading-bot'). Always required." },
            },
            required: ['message', 'session'],
        },
    },
    {
        type: 'function',
        name: 'processPermissionRequest',
        description: "Approve or deny a permission request from Claude Code. You MUST specify the 'session' parameter with the project folder name. Always confirm which session with the user if unclear.",
        parameters: {
            type: 'object',
            properties: {
                decision: { type: 'string', description: "Whether to allow or deny the permission request. Must be 'allow' or 'deny'." },
                session: { type: 'string', description: 'Target session name (folder name). Always required.' },
            },
            required: ['decision', 'session'],
        },
    },
    {
        type: 'function',
        name: 'switchSession',
        description: 'Switch the app screen to display a specific session. Use when the user asks to see a session, or when context makes it clear they want to view a different project. Always specify the session name.',
        parameters: {
            type: 'object',
            properties: {
                session: { type: 'string', description: "Target session name (folder name like 'trading-bot'). Always required." },
            },
            required: ['session'],
        },
    },
];
