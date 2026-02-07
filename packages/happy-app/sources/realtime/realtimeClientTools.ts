import { z } from 'zod';
import { router } from 'expo-router';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny, sessionDelete, machineSpawnNewSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { trackPermissionResponse } from '@/track';
import { getCurrentRealtimeSessionId, setCurrentRealtimeSessionId, stopRealtimeSession } from './RealtimeSession';
import { getSessionName, getSessionSubtitle, isSessionOnline } from '@/utils/sessionUtils';

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code.
 */
export const realtimeClientTools = {
    /**
     * Send a message to Claude Code
     */
    messageClaudeCode: async (parameters: unknown) => {
        // Parse and validate the message parameter using Zod
        const messageSchema = z.object({
            message: z.string().min(1, 'Message cannot be empty')
        });
        const parsedMessage = messageSchema.safeParse(parameters);

        if (!parsedMessage.success) {
            console.error('❌ Invalid message parameter:', parsedMessage.error);
            return "error (invalid message parameter)";
        }

        const message = parsedMessage.data.message;
        const sessionId = getCurrentRealtimeSessionId();
        
        if (!sessionId) {
            console.error('❌ No active session');
            return "error (no active session)";
        }
        
        console.log('🔍 messageClaudeCode called with:', message);
        console.log('📤 Sending message to session:', sessionId);
        sync.sendMessage(sessionId, message);
        return "sent [Do not announce 'sent' or any delivery confirmation]";
    },

    /**
     * Process a permission request from Claude Code
     */
    processPermissionRequest: async (parameters: unknown) => {
        const messageSchema = z.object({
            decision: z.enum(['allow', 'deny'])
        });
        const parsedMessage = messageSchema.safeParse(parameters);

        if (!parsedMessage.success) {
            console.error('❌ Invalid decision parameter:', parsedMessage.error);
            return "error (invalid decision parameter, expected 'allow' or 'deny')";
        }

        const decision = parsedMessage.data.decision;
        const sessionId = getCurrentRealtimeSessionId();
        
        if (!sessionId) {
            console.error('❌ No active session');
            return "error (no active session)";
        }
        
        console.log('🔍 processPermissionRequest called with:', decision);
        
        // Get the current session to check for permission requests
        const session = storage.getState().sessions[sessionId];
        const requests = session?.agentState?.requests;
        
        if (!requests || Object.keys(requests).length === 0) {
            console.error('❌ No active permission request');
            return "error (no active permission request)";
        }
        
        const requestId = Object.keys(requests)[0];
        
        try {
            if (decision === 'allow') {
                await sessionAllow(sessionId, requestId);
                trackPermissionResponse(true);
            } else {
                await sessionDeny(sessionId, requestId);
                trackPermissionResponse(false);
            }
            return "done [DO NOT say anything else, simply say 'done']";
        } catch (error) {
            console.error('❌ Failed to process permission:', error);
            return `error (failed to ${decision} permission)`;
        }
    },

    /**
     * Manage sessions: list, switch, or create
     */
    manageSession: async (parameters: unknown) => {
        const schema = z.object({
            action: z.enum(['list', 'switch', 'create']),
            sessionId: z.string().optional(),
            directory: z.string().optional(),
            includeOffline: z.boolean().optional(),
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid manageSession parameters:', parsed.error);
            return "error (invalid parameters, expected action: 'list', 'switch', or 'create')";
        }

        const { action, sessionId, directory, includeOffline } = parsed.data;

        if (action === 'list') {
            const allSessions = Object.values(storage.getState().sessions);
            const sessions = includeOffline ? allSessions : allSessions.filter(s => isSessionOnline(s));
            const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt);

            if (sorted.length === 0) {
                return includeOffline ? "No sessions found." : "No online sessions found. Try again with includeOffline: true to see all sessions.";
            }

            const list = sorted.map((s, i) => {
                const name = getSessionName(s);
                const path = getSessionSubtitle(s);
                const active = s.id === getCurrentRealtimeSessionId() ? ' (current)' : '';
                return `${i + 1}. "${name}" - ${path}${active} (id: ${s.id})`;
            }).join('\n');

            const label = includeOffline ? '' : ' online';
            return `Found ${sorted.length}${label} sessions:\n${list}\n\nTell the user the session names. To switch, call manageSession with action "switch" and the sessionId.`;
        }

        if (action === 'switch') {
            if (!sessionId) {
                return "error (sessionId is required for switch action)";
            }

            const session = storage.getState().sessions[sessionId];
            if (!session) {
                return "error (session not found)";
            }

            try {
                setCurrentRealtimeSessionId(sessionId);
                router.navigate(`/session/${sessionId}`);
                return `Switched to session "${getSessionName(session)}". [DO NOT say anything else, simply confirm the switch]`;
            } catch (error) {
                console.error('❌ Failed to switch session:', error);
                return "error (failed to navigate to session)";
            }
        }

        if (action === 'create') {
            // Find a machine to create the session on
            const currentSessionId = getCurrentRealtimeSessionId();
            const currentSession = currentSessionId ? storage.getState().sessions[currentSessionId] : null;
            const machineId = currentSession?.metadata?.machineId;

            if (!machineId) {
                return "error (no machine available to create session on)";
            }

            const dir = directory || currentSession?.metadata?.path || '/';

            try {
                const result = await machineSpawnNewSession({
                    machineId,
                    directory: dir,
                });

                if (result.type === 'success') {
                    setCurrentRealtimeSessionId(result.sessionId);
                    router.navigate(`/session/${result.sessionId}`);
                    return `Created new session and navigated to it. [DO NOT say anything else, simply confirm creation]`;
                } else if (result.type === 'requestToApproveDirectoryCreation') {
                    return `The directory "${result.directory}" does not exist. Ask the user if they want to create it.`;
                } else {
                    return `error (${result.errorMessage})`;
                }
            } catch (error) {
                console.error('❌ Failed to create session:', error);
                return "error (failed to create session)";
            }
        }

        return "error (unknown action)";
    },

    /**
     * Change session settings (permission mode or model)
     */
    changeSessionSettings: async (parameters: unknown) => {
        const schema = z.object({
            setting: z.enum(['permissionMode', 'modelMode']),
            value: z.string(),
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid changeSessionSettings parameters:', parsed.error);
            return "error (invalid parameters)";
        }

        const { setting, value } = parsed.data;
        const sessionId = getCurrentRealtimeSessionId();

        if (!sessionId) {
            return "error (no active session)";
        }

        try {
            if (setting === 'permissionMode') {
                const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo'] as const;
                if (!validModes.includes(value as any)) {
                    return `error (invalid permission mode. Valid modes: ${validModes.join(', ')})`;
                }
                storage.getState().updateSessionPermissionMode(sessionId, value as typeof validModes[number]);
                return `Permission mode changed to "${value}". [DO NOT say anything else, simply confirm]`;
            }

            if (setting === 'modelMode') {
                const validModels = ['default', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const;
                if (!validModels.includes(value as any)) {
                    return `error (invalid model. Valid models: ${validModels.join(', ')})`;
                }
                storage.getState().updateSessionModelMode(sessionId, value as typeof validModels[number]);
                return `Model changed to "${value}". [DO NOT say anything else, simply confirm]`;
            }
        } catch (error) {
            console.error('❌ Failed to change setting:', error);
            return "error (failed to change setting)";
        }

        return "error (unknown setting)";
    },

    /**
     * Get current session status
     */
    getSessionStatus: async (_parameters: unknown) => {
        const sessionId = getCurrentRealtimeSessionId();

        if (!sessionId) {
            return "error (no active session)";
        }

        const session = storage.getState().sessions[sessionId];
        if (!session) {
            return "error (session not found)";
        }

        const name = getSessionName(session);
        const path = getSessionSubtitle(session);
        const online = isSessionOnline(session) ? 'online' : 'offline';
        const thinking = session.thinking ? 'yes, AI is currently working' : 'no';
        const permissionMode = session.permissionMode || 'default';
        const model = session.modelMode || 'default';
        const pendingRequests = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0;

        return `Session status:
- Name: ${name}
- Path: ${path}
- Status: ${online}
- AI thinking: ${thinking}
- Permission mode: ${permissionMode}
- Model: ${model}
- Pending permission requests: ${pendingRequests}

Report this information to the user in a natural, conversational way.`;
    },

    /**
     * Delete a session
     */
    deleteSessionTool: async (parameters: unknown) => {
        const schema = z.object({
            sessionId: z.string(),
            confirmed: z.boolean(),
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid deleteSession parameters:', parsed.error);
            return "error (invalid parameters, expected sessionId and confirmed: true)";
        }

        const { sessionId: targetId, confirmed } = parsed.data;

        if (!confirmed) {
            const session = storage.getState().sessions[targetId];
            const name = session ? getSessionName(session) : targetId;
            return `Are you sure you want to delete session "${name}"? Call deleteSessionTool again with confirmed: true to proceed.`;
        }

        try {
            const result = await sessionDelete(targetId);
            if (result.success) {
                storage.getState().deleteSession(targetId);
                return `Session deleted. [DO NOT say anything else, simply confirm]`;
            } else {
                return `error (${result.message || 'failed to delete session'})`;
            }
        } catch (error) {
            console.error('❌ Failed to delete session:', error);
            return "error (failed to delete session)";
        }
    },

    /**
     * Navigate to home screen (leave current conversation)
     */
    navigateHome: async (_parameters: unknown) => {
        try {
            try { router.dismissAll(); } catch (_) { /* stack may already be at root */ }
            router.replace('/');
            return "Navigated to home screen. [DO NOT say anything else, simply confirm]";
        } catch (error) {
            console.error('❌ Failed to navigate home:', error);
            return "error (failed to navigate home)";
        }
    },

    /**
     * End the voice conversation (disconnect voice assistant)
     */
    endVoiceConversation: async (_parameters: unknown) => {
        try {
            await stopRealtimeSession();
            return "Voice conversation ended. [DO NOT say anything else]";
        } catch (error) {
            console.error('❌ Failed to end voice conversation:', error);
            return "error (failed to end voice conversation)";
        }
    },
};