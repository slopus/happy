import { router } from 'expo-router';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny, sessionDelete, machineSpawnNewSession } from '@/sync/ops';
import { storage, getSession } from '@/sync/storage';
import { trackPermissionResponse } from '@/track';
import { getCurrentRealtimeSessionId, setCurrentRealtimeSessionId, stopRealtimeSession } from './RealtimeSession';
import { getSessionName, getSessionSubtitle, isSessionOnline, formatPathRelativeToHome } from '@/utils/sessionUtils';
import {
    changeSessionSettingsParametersSchema,
    createSessionParametersSchema,
    deleteSessionParametersSchema,
    getLatestAssistantReplyParametersSchema,
    listSessionsParametersSchema,
    messageClaudeCodeParametersSchema,
    processPermissionRequestParametersSchema,
    switchSessionParametersSchema,
} from './voiceToolContracts';
import { getSendConfirmation, getVoiceProvider } from '@/sync/voiceConfig';
import { showSendConfirmation } from './SendConfirmationModal';
import { MODEL_MODES } from '@/constants/modelCatalog';

function getLatestAssistantReplyFromCurrentSession(maxChars: number): string | null {
    const sessionId = getCurrentRealtimeSessionId();
    if (!sessionId) {
        return null;
    }

    const sessionMessages = storage.getState().sessionMessages[sessionId];
    const messages = sessionMessages?.messages ?? [];
    // messages are sorted descending (newest first), so iterate from index 0
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.kind !== 'agent-text') {
            continue;
        }
        const text = message.text?.trim();
        if (!text) {
            continue;
        }
        if (text.length <= maxChars) {
            return text;
        }
        return `${text.slice(0, maxChars)}...`;
    }

    return null;
}

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with the active coding agent.
 */
export const realtimeClientTools = {
    /**
     * Send a message to the active coding agent
     */
    messageClaudeCode: async (parameters: unknown) => {
        // Parse and validate the message parameter using Zod
        const parsedMessage = messageClaudeCodeParametersSchema.safeParse(parameters);

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

        if (getSendConfirmation()) {
            const confirmationPromise = showSendConfirmation(message).then((result) => {
                if (result === 'sent') {
                    console.log('📤 Confirmed, sending message to session:', sessionId);
                    sync.sendMessage(sessionId, message);
                } else {
                    console.log('🚫 Message cancelled by user');
                }
                return result;
            });

            // Happy Voice supports async tool results via RPC, so we can await.
            // ElevenLabs SDK doesn't wait for async tools, so fire-and-forget.
            if (getVoiceProvider() === 'happy-voice') {
                const result = await confirmationPromise;
                return result === 'sent' ? 'sent' : 'cancelled by user';
            }

            return "sent";
        }

        sync.sendMessage(sessionId, message);
        return "sent";
    },

    /**
     * Process a permission request from the coding agent
     */
    processPermissionRequest: async (parameters: unknown) => {
        const parsedMessage = processPermissionRequestParametersSchema.safeParse(parameters);

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
        const session = getSession(sessionId);
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
            return "done";
        } catch (error) {
            console.error('❌ Failed to process permission:', error);
            return `error (failed to ${decision} permission)`;
        }
    },

    /**
     * List all sessions
     */
    listSessions: async (parameters: unknown) => {
        const parsed = listSessionsParametersSchema.safeParse(parameters ?? {});

        if (!parsed.success) {
            console.error('❌ Invalid listSessions parameters:', parsed.error);
            return "error (invalid parameters)";
        }

        const { includeOffline } = parsed.data;
        const allSessions = Object.values(storage.getState().sessions);
        const sessions = includeOffline ? allSessions : allSessions.filter(s => isSessionOnline(s));

        if (sessions.length === 0) {
            return includeOffline ? "No sessions found." : "No online sessions found. Try again with includeOffline: true to see all sessions.";
        }

        // Group sessions by project path, then by machine — matching home screen order
        const projectGroups = new Map<string, {
            displayPath: string;
            machines: Map<string, { machineName: string; sessions: typeof sessions }>;
        }>();

        const machines = storage.getState().machines;

        sessions.forEach(s => {
            const projectPath = s.metadata?.path || '';
            const machineId = s.metadata?.machineId || 'unknown';
            const machine = machineId !== 'unknown' ? machines[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== 'unknown' ? machineId : '<unknown>');

            let projectGroup = projectGroups.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, s.metadata?.homeDir);
                projectGroup = { displayPath, machines: new Map() };
                projectGroups.set(projectPath, projectGroup);
            }

            let machineGroup = projectGroup.machines.get(machineId);
            if (!machineGroup) {
                machineGroup = { machineName, sessions: [] };
                projectGroup.machines.set(machineId, machineGroup);
            }

            machineGroup.sessions.push(s);
        });

        // Sort: projects by displayPath, machines by name, sessions by createdAt desc
        const sortedProjects = Array.from(projectGroups.entries())
            .sort(([, a], [, b]) => a.displayPath.localeCompare(b.displayPath));

        const lines: string[] = [];
        let index = 1;

        for (const [, projectGroup] of sortedProjects) {
            const sortedMachines = Array.from(projectGroup.machines.entries())
                .sort(([, a], [, b]) => a.machineName.localeCompare(b.machineName));

            for (const [, machineGroup] of sortedMachines) {
                machineGroup.sessions.sort((a, b) => b.createdAt - a.createdAt);

                lines.push(`[${projectGroup.displayPath}] (${machineGroup.machineName})`);
                for (const s of machineGroup.sessions) {
                    const name = getSessionName(s);
                    const active = s.id === getCurrentRealtimeSessionId() ? ' (current)' : '';
                    lines.push(`  ${index}. "${name}"${active} (id: ${s.id})`);
                    index++;
                }
            }
        }

        const label = includeOffline ? '' : ' online';
        return `Found ${sessions.length}${label} sessions:\n${lines.join('\n')}`;
    },

    /**
     * Switch to a different session
     */
    switchSession: async (parameters: unknown) => {
        const parsed = switchSessionParametersSchema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid switchSession parameters:', parsed.error);
            return "error (invalid parameters, sessionId is required)";
        }

        const { sessionId } = parsed.data;
        const session = getSession(sessionId);
        if (!session) {
            return "error (session not found)";
        }

        try {
            setCurrentRealtimeSessionId(sessionId);
            router.navigate(`/session/${sessionId}`);
            return `Switched to session "${getSessionName(session)}".`;
        } catch (error) {
            console.error('❌ Failed to switch session:', error);
            return "error (failed to navigate to session)";
        }
    },

    /**
     * Create a new session
     */
    createSession: async (parameters: unknown) => {
        const parsed = createSessionParametersSchema.safeParse(parameters ?? {});

        if (!parsed.success) {
            console.error('❌ Invalid createSession parameters:', parsed.error);
            return "error (invalid parameters)";
        }

        const { directory } = parsed.data;
        const currentSessionId = getCurrentRealtimeSessionId();
        const currentSession = currentSessionId ? getSession(currentSessionId) ?? null : null;
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
                return "Created new session.";
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                return `The directory "${result.directory}" does not exist. Ask the user if they want to create it.`;
            } else {
                return `error (${result.errorMessage})`;
            }
        } catch (error) {
            console.error('❌ Failed to create session:', error);
            return "error (failed to create session)";
        }
    },

    /**
     * Change session settings (permission mode or model)
     */
    changeSessionSettings: async (parameters: unknown) => {
        const parsed = changeSessionSettingsParametersSchema.safeParse(parameters);

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
                return `Permission mode changed to "${value}".`;
            }

            if (setting === 'modelMode') {
                const validModels = MODEL_MODES;
                if (!validModels.includes(value as any)) {
                    return `error (invalid model. Valid models: ${validModels.join(', ')})`;
                }
                storage.getState().updateSessionModelMode(sessionId, value);
                return `Model changed to "${value}".`;
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

        const session = getSession(sessionId);
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

        return `Session status:\n- Name: ${name}\n- Path: ${path}\n- Status: ${online}\n- AI thinking: ${thinking}\n- Permission mode: ${permissionMode}\n- Model: ${model}\n- Pending permission requests: ${pendingRequests}`;
    },

    /**
     * Get the latest assistant text reply from current session
     */
    getLatestAssistantReply: async (parameters: unknown) => {
        const parsed = getLatestAssistantReplyParametersSchema.safeParse(parameters ?? {});

        if (!parsed.success) {
            console.error('❌ Invalid getLatestAssistantReply parameters:', parsed.error);
            return 'error (invalid parameters)';
        }

        const sessionId = getCurrentRealtimeSessionId();
        if (!sessionId) {
            return "error (no active session)";
        }

        const maxChars = parsed.data.maxChars ?? 800;
        const latestReply = getLatestAssistantReplyFromCurrentSession(maxChars);
        if (!latestReply) {
            return 'No recent assistant reply found in the current session.';
        }

        return `Latest assistant reply:\n${latestReply}`;
    },

    /**
     * Delete a session
     */
    deleteSessionTool: async (parameters: unknown) => {
        const parsed = deleteSessionParametersSchema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid deleteSession parameters:', parsed.error);
            return "error (invalid parameters, expected sessionId and confirmed: true)";
        }

        const { sessionId: targetId, confirmed } = parsed.data;

        if (!confirmed) {
            const session = getSession(targetId);
            const name = session ? getSessionName(session) : targetId;
            return `Are you sure you want to delete session "${name}"? Call deleteSessionTool again with confirmed: true to proceed.`;
        }

        try {
            const result = await sessionDelete(targetId);
            if (result.success) {
                storage.getState().deleteSession(targetId);
                return "Session deleted.";
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
            return "Navigated to home screen.";
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
            return "Voice conversation ended.";
        } catch (error) {
            console.error('❌ Failed to end voice conversation:', error);
            return "error (failed to end voice conversation)";
        }
    },
};
