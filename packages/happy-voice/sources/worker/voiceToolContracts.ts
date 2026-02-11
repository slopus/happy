import { z } from 'zod';

const bridgedVoiceToolNameSchema = z.enum([
    'messageClaudeCode',
    'processPermissionRequest',
    'listSessions',
    'switchSession',
    'createSession',
    'changeSessionSettings',
    'getSessionStatus',
    'getLatestAssistantReply',
    'deleteSessionTool',
    'navigateHome',
    'endVoiceConversation',
] as const);

export type BridgedVoiceToolName = z.infer<typeof bridgedVoiceToolNameSchema>;

export const bridgedVoiceToolDescriptions: Record<BridgedVoiceToolName, string> = {
    messageClaudeCode: 'Forward a message to the coding agent. Use when the user explicitly asks to send something to Happy, or for code/project tasks. For app operations (sessions, settings, navigation) use the dedicated tools instead.',
    processPermissionRequest: 'Allow or deny a pending permission request.',
    listSessions: 'List all coding sessions.',
    switchSession: 'Switch to a different coding session by its ID.',
    createSession: 'Create a new coding session.',
    changeSessionSettings: 'Change session settings such as model or permission mode.',
    getSessionStatus: 'Get current status from the active coding session.',
    getLatestAssistantReply: 'Use when the user asks what Happy just replied. Returns the latest assistant text from the active coding session.',
    deleteSessionTool: 'Delete an existing coding session after confirmation.',
    navigateHome: 'Navigate to the home screen and leave the current conversation.',
    endVoiceConversation: 'End the current voice conversation.',
};

export const messageClaudeCodeParametersSchema = z.object({
    message: z.string().min(1, 'Message cannot be empty'),
});

export const processPermissionRequestParametersSchema = z.object({
    decision: z.enum(['allow', 'deny']),
});

// Raw JSON schema to avoid zod-to-json-schema forcing optional fields into "required".
// With Zod v3 + target 'openAi', `.optional()` is converted to `.nullable()` and still
// marked required, which deters the LLM from calling the tool.
export const listSessionsParametersSchema = {
    type: 'object' as const,
    properties: {
        includeOffline: { type: 'boolean' as const, description: 'Include offline sessions. Defaults to false.' },
    },
    required: [] as string[],
    additionalProperties: false,
};

export const switchSessionParametersSchema = z.object({
    sessionId: z.string().min(1, 'sessionId is required'),
});

// Raw JSON schema — same reason as listSessionsParametersSchema above.
export const createSessionParametersSchema = {
    type: 'object' as const,
    properties: {
        directory: { type: 'string' as const, description: 'Working directory for the new session' },
    },
    required: [] as string[],
    additionalProperties: false,
};

export const changeSessionSettingsParametersSchema = z.object({
    setting: z.enum(['permissionMode', 'modelMode']),
    value: z.string(),
});

// Raw JSON schema — same reason as listSessionsParametersSchema above.
export const getLatestAssistantReplyParametersSchema = {
    type: 'object' as const,
    properties: {
        maxChars: { type: 'integer' as const, minimum: 1, maximum: 2000, description: 'Max characters to return' },
    },
    required: [] as string[],
    additionalProperties: false,
};

export const deleteSessionParametersSchema = z.object({
    sessionId: z.string(),
    confirmed: z.boolean(),
});

export const navigateHomeParametersSchema = z.object({});

export const endVoiceConversationParametersSchema = z.object({});
