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

export const listSessionsParametersSchema = z.object({
    includeOffline: z.boolean().optional(),
});

export const switchSessionParametersSchema = z.object({
    sessionId: z.string().min(1, 'sessionId is required'),
});

export const createSessionParametersSchema = z.object({
    directory: z.string().optional(),
});

export const changeSessionSettingsParametersSchema = z.object({
    setting: z.enum(['permissionMode', 'modelMode']),
    value: z.string(),
});

export const getLatestAssistantReplyParametersSchema = z.object({
    maxChars: z.number().int().positive().max(2000).optional(),
});

export const deleteSessionParametersSchema = z.object({
    sessionId: z.string(),
    confirmed: z.boolean(),
});

export const navigateHomeParametersSchema = z.object({});

export const endVoiceConversationParametersSchema = z.object({});
