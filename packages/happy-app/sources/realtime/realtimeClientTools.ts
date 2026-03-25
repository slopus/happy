import { z } from 'zod';
import { type v3 } from '@slopus/happy-sync';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { trackPermissionResponse } from '@/track';
import { getCurrentRealtimeSessionId } from './RealtimeSession';

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
        return "sent [DO NOT say anything else, simply say 'sent']";
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
        
        // Get pending permissions from SyncNode (single source of truth)
        const syncSession = sync.appSyncStore?.getSession(sessionId as v3.SessionID);
        const pendingPermissions = syncSession?.permissions.filter((p) => !p.resolved) ?? [];

        if (pendingPermissions.length === 0) {
            console.error('❌ No active permission request');
            return "error (no active permission request)";
        }

        const requestId = pendingPermissions[0].permissionId;
        
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
    }
};