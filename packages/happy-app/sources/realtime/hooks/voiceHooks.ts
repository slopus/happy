import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted, setCurrentRealtimeSessionId } from '../RealtimeSession';
import {
    formatNewMessages,
    formatPermissionRequest,
    formatReadyEvent,
    formatSessionFocus,
    formatSessionFull,
    formatSessionOffline,
    formatSessionOnline
} from './contextFormatters';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { type SessionMessage, type SessionID } from '@slopus/happy-sync';
import { VOICE_CONFIG } from '../voiceConfig';

/**
 * Centralized voice assistant hooks for multi-session context updates.
 *
 * Two update channels:
 * - sendContext()  → silent background injection (sendContextualUpdate), always immediate
 * - sendPrompt()  → triggers agent response (sendTextMessage), queued while anyone is speaking
 *
 * Prompt queue flushes automatically when realtimeMode transitions to 'idle'.
 */

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    [key: string]: any;
}

let shownSessions = new Set<string>();

// Prompt queue — batched text messages that trigger agent responses
let pendingPrompts: string[] = [];

// Subscribe to realtimeMode changes to flush when idle
let unsubscribeMode: (() => void) | null = null;
let lastRealtimeMode: string | null = null;

function ensureModeSubscription() {
    if (unsubscribeMode) return;
    lastRealtimeMode = storage.getState().realtimeMode;
    unsubscribeMode = storage.subscribe((state) => {
        const mode = state.realtimeMode;
        if (mode !== lastRealtimeMode) {
            lastRealtimeMode = mode;
            if (mode === 'idle') {
                flushPendingPrompts();
            }
        }
    });
}

function flushPendingPrompts() {
    if (pendingPrompts.length === 0) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) {
        pendingPrompts = [];
        return;
    }
    const batched = pendingPrompts.join('\n\n');
    pendingPrompts = [];
    voice.sendTextMessage(batched);
}

/**
 * Send silent background context — always immediate, never queued.
 */
function sendContext(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: sendContext:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(update);
}

/**
 * Send a prompt that triggers an agent response.
 * Queued while anyone (user or agent) is speaking, flushed on idle.
 */
function sendPrompt(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: sendPrompt:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;

    const mode = storage.getState().realtimeMode;
    if (mode === 'idle') {
        voice.sendTextMessage(update);
    } else {
        pendingPrompts.push(update);
    }
}

/**
 * Inject full context for a session if not already shown.
 * Shared code path for both voice start and session focus.
 * Returns the formatted string (for initial prompt building) or null if already shown.
 */
function injectSessionContext(sessionId: string): string | null {
    if (shownSessions.has(sessionId)) return null;
    shownSessions.add(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!session) return null;
    const messages = sync.appSyncStore?.getMessages(sessionId as SessionID) ?? [];
    return formatSessionFull(session, messages);
}

/**
 * Build a one-line directory of all active sessions (id + summary).
 */
function formatSessionDirectory(): string {
    const activeSessions = storage.getState().getActiveSessions();
    if (activeSessions.length === 0) return 'No active sessions.';
    const lines = activeSessions.map(s => {
        const summary = s.metadata?.summary?.text ?? 'No summary';
        return `- ${s.id}: "${summary}"`;
    });
    return 'Available sessions:\n' + lines.join('\n');
}

export const voiceHooks = {

    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOnline(sessionId, metadata));
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOffline(sessionId, metadata));
    },

    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_FOCUS) return;
        if (getCurrentRealtimeSessionId() === sessionId) return;
        setCurrentRealtimeSessionId(sessionId);
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionFocus(sessionId, metadata));
    },

    /**
     * Called when Claude requests permission for a tool use
     */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: any) {
        if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(formatPermissionRequest(sessionId, requestId, toolName, toolArgs));
    },

    /**
     * Called when agent sends a message/response
     */
    onMessages(sessionId: string, messages: SessionMessage[]) {
        if (VOICE_CONFIG.DISABLE_MESSAGES) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatNewMessages(sessionId, messages));
    },

    /**
     * Called when voice session starts.
     * Builds initial prompt with session directory + full current session context.
     */
    onVoiceStarted(sessionId: string): string {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session started for:', sessionId);
        }
        shownSessions.clear();
        pendingPrompts = [];
        ensureModeSubscription();

        let prompt = '';

        // Session directory — all active sessions with titles
        prompt += formatSessionDirectory() + '\n\n';

        // Full context for the current session
        const ctx = injectSessionContext(sessionId);
        if (ctx) {
            prompt += 'CURRENT SESSION:\n\n' + ctx;
        }

        return prompt;
    },

    /**
     * Called when Claude Code finishes processing (ready event)
     */
    onReady(sessionId: string) {
        if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(formatReadyEvent(sessionId));
    },

    /**
     * Called when voice session stops
     */
    onVoiceStopped() {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session stopped');
        }
        shownSessions.clear();
        pendingPrompts = [];
    }
};
