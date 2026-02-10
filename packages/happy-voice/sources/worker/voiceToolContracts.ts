import { z } from 'zod';

const bridgedVoiceToolNameSchema = z.enum([
    'messageClaudeCode',
    'processPermissionRequest',
    'manageSession',
    'changeSessionSettings',
    'getSessionStatus',
    'getLatestAssistantReply',
    'deleteSessionTool',
    'navigateHome',
    'endVoiceConversation',
] as const);

export type BridgedVoiceToolName = z.infer<typeof bridgedVoiceToolNameSchema>;

export const bridgedVoiceToolDescriptions: Record<BridgedVoiceToolName, string> = {
    messageClaudeCode: 'Send a message to the coding agent in the active session.',
    processPermissionRequest: 'Allow or deny a pending permission request.',
    manageSession: 'List, switch, or create coding sessions.',
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

export const manageSessionParametersSchema = z.object({
    action: z.enum(['list', 'switch', 'create']),
    sessionId: z.string().optional(),
    directory: z.string().optional(),
    includeOffline: z.boolean().optional(),
});

export const changeSessionSettingsParametersSchema = z.object({
    setting: z.enum(['permissionMode', 'modelMode']),
    value: z.string(),
});

export const getLatestAssistantReplyParametersSchema = z.object({
    maxChars: z.number().int().min(1).max(2000).optional(),
});

export const deleteSessionParametersSchema = z.object({
    sessionId: z.string(),
    confirmed: z.boolean(),
});

export const navigateHomeParametersSchema = z.object({});

export const endVoiceConversationParametersSchema = z.object({});
