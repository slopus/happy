import { z } from 'zod';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { trackPermissionResponse } from '@/track';
import { getCurrentRealtimeSessionId } from './RealtimeSession';
import { getSessionLabel } from './hooks/contextFormatters';
import { router } from 'expo-router';

/**
 * Resolve a session ID from a user-provided session name/hint.
 * Matches against folder name, summary text, or raw session ID.
 * Falls back to the currently focused session if no hint given.
 */
function resolveSessionId(sessionHint?: string): string | null {
    // No hint — use focused session
    if (!sessionHint || sessionHint.trim() === '') {
        return getCurrentRealtimeSessionId();
    }

    const hint = sessionHint.toLowerCase().trim();
    const sessions = storage.getState().getActiveSessions();

    // Try exact folder name match first
    for (const s of sessions) {
        if (s.metadata?.path) {
            const folder = s.metadata.path.split('/').filter(Boolean).pop()?.toLowerCase();
            if (folder === hint) return s.id;
        }
    }

    // Try partial folder name match
    for (const s of sessions) {
        if (s.metadata?.path) {
            const folder = s.metadata.path.split('/').filter(Boolean).pop()?.toLowerCase() || '';
            if (folder.includes(hint) || hint.includes(folder)) return s.id;
        }
    }

    // Try summary text match
    for (const s of sessions) {
        const summary = s.metadata?.summary?.text?.toLowerCase() || '';
        if (summary.includes(hint)) return s.id;
    }

    // Try session ID prefix
    for (const s of sessions) {
        if (s.id.toLowerCase().startsWith(hint)) return s.id;
    }

    return null;
}

/**
 * Navigate to a session screen using expo-router's imperative API.
 * Safe to call from outside React components.
 */
function navigateToSessionImperative(sessionId: string) {
    try {
        router.navigate(`/session/${sessionId}`, {
            dangerouslySingular(name, params) {
                return 'session';
            },
        });
    } catch (error) {
        console.error('Failed to navigate to session:', error);
    }
}

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code
 * across multiple sessions.
 */
export const realtimeClientTools = {
    /**
     * Send a message to Claude Code.
     * Supports multi-session routing via optional session parameter.
     */
    messageClaudeCode: async (parameters: unknown) => {
        const messageSchema = z.object({
            message: z.string().min(1, 'Message cannot be empty'),
            session: z.string().min(1, 'Session name is required')
        });
        const parsed = messageSchema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid parameters:', parsed.error);
            const active = storage.getState().getActiveSessions();
            const names = active.map(s => `"${getSessionLabel(s)}"`).join(', ');
            return `error (both message and session are required). Available sessions: ${names}`;
        }

        const { message, session: sessionHint } = parsed.data;
        const sessionId = resolveSessionId(sessionHint);

        if (!sessionId) {
            // List available sessions to help the agent
            const active = storage.getState().getActiveSessions();
            const names = active.map(s => `"${getSessionLabel(s)}"`).join(', ');
            return `error (could not find session matching "${sessionHint}"). Available sessions: ${names}`;
        }

        const sessionObj = storage.getState().sessions[sessionId];
        const label = sessionObj ? getSessionLabel(sessionObj) : sessionId.slice(0, 8);

        console.log(`📤 Sending message to "${label}" (${sessionId}):`, message);
        sync.sendMessage(sessionId, message);
        return `sent to "${label}" [DO NOT say anything else, simply say 'sent to ${label}']`;
    },

    /**
     * Process a permission request from Claude Code.
     * Supports multi-session routing via optional session parameter.
     */
    processPermissionRequest: async (parameters: unknown) => {
        const messageSchema = z.object({
            decision: z.enum(['allow', 'deny']),
            session: z.string().min(1, 'Session name is required')
        });
        const parsed = messageSchema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid parameters:', parsed.error);
            // List sessions with pending requests to help the agent
            const active = storage.getState().getActiveSessions();
            const withRequests = active.filter(s => {
                const reqs = s.agentState?.requests;
                return reqs && Object.keys(reqs).length > 0;
            });
            if (withRequests.length > 0) {
                const names = withRequests.map(s => `"${getSessionLabel(s)}"`).join(', ');
                return `error (both decision and session are required). Sessions with pending requests: ${names}`;
            }
            return "error (both decision and session are required, expected 'allow'/'deny' and a session name)";
        }

        const { decision, session: sessionHint } = parsed.data;
        const sessionId = resolveSessionId(sessionHint);

        if (!sessionId) {
            return "error (no active session found)";
        }

        const session = storage.getState().sessions[sessionId];
        const requests = session?.agentState?.requests;

        if (!requests || Object.keys(requests).length === 0) {
            const label = session ? getSessionLabel(session) : sessionId.slice(0, 8);
            return `error (no pending permission request in "${label}")`;
        }

        const requestId = Object.keys(requests)[0];
        const label = session ? getSessionLabel(session) : sessionId.slice(0, 8);

        try {
            if (decision === 'allow') {
                await sessionAllow(sessionId, requestId);
                trackPermissionResponse(true);
            } else {
                await sessionDeny(sessionId, requestId);
                trackPermissionResponse(false);
            }
            return `done [DO NOT say anything else, simply say '${decision === 'allow' ? 'approved' : 'denied'} for ${label}']`;
        } catch (error) {
            console.error('❌ Failed to process permission:', error);
            return `error (failed to ${decision} permission for "${label}")`;
        }
    },

    /**
     * Switch the app screen to show a specific session.
     */
    switchSession: async (parameters: unknown) => {
        const schema = z.object({
            session: z.string().min(1, 'Session name is required')
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            const active = storage.getState().getActiveSessions();
            const names = active.map(s => `"${getSessionLabel(s)}"`).join(', ');
            return `error (session name is required). Available sessions: ${names}`;
        }

        const sessionId = resolveSessionId(parsed.data.session);

        if (!sessionId) {
            const active = storage.getState().getActiveSessions();
            const names = active.map(s => `"${getSessionLabel(s)}"`).join(', ');
            return `error (could not find session "${parsed.data.session}"). Available sessions: ${names}`;
        }

        const sessionObj = storage.getState().sessions[sessionId];
        const label = sessionObj ? getSessionLabel(sessionObj) : sessionId.slice(0, 8);

        navigateToSessionImperative(sessionId);

        return `switched to "${label}" [DO NOT say anything else, simply say 'switched to ${label}']`;
    }
};
