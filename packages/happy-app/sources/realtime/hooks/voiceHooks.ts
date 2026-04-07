import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted, setCurrentRealtimeSessionId } from '../RealtimeSession';
import {
    formatMessage,
    formatNewMessages,
    formatPermissionRequest,
    formatReadyEvent,
    formatSessionFocus,
    formatSessionFull,
    formatSessionOffline,
    formatSessionOnline,
    extractTerms,
    formatGlossary
} from './contextFormatters';
import { storage } from '@/sync/storage';
import { Message } from '@/sync/typesMessage';
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
let lastFocusSession: string | null = null;
let glossaryTerms = new Set<string>();
let focusSwitchedAt = 0;

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
 * Also extracts jargon terms and sends glossary for transcription accuracy.
 */
function sendContext(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: sendContext:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;

    // Extract jargon terms and send glossary
    for (const term of extractTerms(update)) {
        glossaryTerms.add(term);
    }
    const glossary = formatGlossary(glossaryTerms);
    if (glossary) {
        voice.sendContextualUpdate(glossary);
    }
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
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    return formatSessionFull(session, messages);
}

export const voiceHooks = {

    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
        if (sessionId !== getCurrentRealtimeSessionId()) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOnline(sessionId, metadata));
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
        if (sessionId !== getCurrentRealtimeSessionId()) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOffline(sessionId, metadata));
    },

    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_FOCUS) return;
        if (!isVoiceSessionStarted()) return;
        if (lastFocusSession === sessionId) return;
        lastFocusSession = sessionId;
        focusSwitchedAt = Date.now();
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
        if (sessionId !== getCurrentRealtimeSessionId()) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(formatPermissionRequest(sessionId, requestId, toolName, toolArgs));
    },

    /**
     * Called when agent sends a message/response
     */
    onMessages(sessionId: string, messages: Message[]) {
        if (VOICE_CONFIG.DISABLE_MESSAGES) return;
        if (sessionId !== getCurrentRealtimeSessionId()) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        const recentMessages = messages.filter(m => m.createdAt >= focusSwitchedAt);
        const agentMessages = recentMessages.filter(m => m.kind !== 'user-text');
        const userMessages = recentMessages.filter(m => m.kind === 'user-text');
        sendPrompt(formatNewMessages(sessionId, agentMessages));
        sendContext(formatNewMessages(sessionId, userMessages));
    },

    /**
     * Called when voice session starts.
     * Seeds glossary from existing session messages.
     */
    onVoiceStarted(sessionId: string): string {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session started for:', sessionId);
        }
        shownSessions.clear();
        shownSessions.add(sessionId);
        glossaryTerms.clear();
        pendingPrompts = [];
        ensureModeSubscription();

        // Seed glossary from existing session messages
        const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
        for (const msg of messages) {
            const text = formatMessage(msg);
            if (text) {
                for (const term of extractTerms(text)) {
                    glossaryTerms.add(term);
                }
            }
        }
        const glossary = formatGlossary(glossaryTerms);
        if (glossary) {
            console.log('🎤 Voice: Sending initial glossary:', glossary);
            const voice = getVoiceSession();
            if (voice && isVoiceSessionStarted()) {
                voice.sendContextualUpdate(glossary);
            }
        }

        return '';
    },

    /**
     * Called when Claude Code finishes processing (ready event)
     */
    onReady(sessionId: string) {
        if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;
        if (sessionId !== getCurrentRealtimeSessionId()) return;

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
        glossaryTerms.clear();
        pendingPrompts = [];
    }
};
