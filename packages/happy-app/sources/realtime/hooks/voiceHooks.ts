import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted } from '../RealtimeSession';
import {
    formatNewMessages,
    formatNewSingleMessage,
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
 * These hooks route app events to the voice assistant with formatted context updates.
 */

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    [key: string]: any;
}

let shownSessions = new Set<string>();
let lastFocusSession: string | null = null;

function reportContextualUpdate(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: Reporting contextual update:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: Voice session:', voice);
    }
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(update);
}

function reportTextUpdate(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: Reporting text update:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: Voice session:', voice);
    }
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendTextMessage(update);
}

function reportSession(sessionId: string) {
    if (shownSessions.has(sessionId)) return;
    shownSessions.add(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!session) return;
    const messages = sync.appSyncStore?.getMessages(sessionId as SessionID) ?? [];
    const contextUpdate = formatSessionFull(session, messages);
    reportContextualUpdate(contextUpdate);
}

export const voiceHooks = {

    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;

        reportSession(sessionId);
        const contextUpdate = formatSessionOnline(sessionId, metadata);
        reportContextualUpdate(contextUpdate);
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;

        reportSession(sessionId);
        const contextUpdate = formatSessionOffline(sessionId, metadata);
        reportContextualUpdate(contextUpdate);
    },


    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_FOCUS) return;
        if (lastFocusSession === sessionId) return;
        lastFocusSession = sessionId;
        reportSession(sessionId);
        reportContextualUpdate(formatSessionFocus(sessionId, metadata));
    },

    /**
     * Called when Claude requests permission for a tool use
     */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: any) {
        if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return;

        reportSession(sessionId);
        reportTextUpdate(formatPermissionRequest(sessionId, requestId, toolName, toolArgs));
    },

    /**
     * Called when agent sends a message/response
     */
    onMessages(sessionId: string, messages: SessionMessage[]) {
        if (VOICE_CONFIG.DISABLE_MESSAGES) return;

        reportSession(sessionId);
        reportContextualUpdate(formatNewMessages(sessionId, messages));
    },

    /**
     * Called when voice session starts
     */
    onVoiceStarted(sessionId: string): string {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session started for:', sessionId);
        }
        shownSessions.clear();
        let prompt = '';
        prompt += 'THIS IS AN ACTIVE SESSION: \n\n' + formatSessionFull(
            storage.getState().sessions[sessionId],
            sync.appSyncStore?.getMessages(sessionId as SessionID) ?? [],
        );
        shownSessions.add(sessionId);
        return prompt;
    },

    /**
     * Called when Claude Code finishes processing (ready event)
     */
    onReady(sessionId: string) {
        if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;

        reportSession(sessionId);
        reportTextUpdate(formatReadyEvent(sessionId));
    },

    /**
     * Called when voice session stops
     */
    onVoiceStopped() {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session stopped');
        }
        shownSessions.clear();
    }
};
