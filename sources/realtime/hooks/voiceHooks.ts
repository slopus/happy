import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted } from '../RealtimeSession';
import {
    formatNewMessages,
    formatNewSingleMessage,
    formatPermissionRequest,
    formatSessionFocus,
    formatSessionFull,
    formatSessionOffline,
    formatSessionOnline
} from './contextFormatters';
import { storage } from '@/sync/storage';
import { Message } from '@/sync/typesMessage';

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

function reportContextualUpdate(update: string | null | undefined) {
    console.log('🎤 Voice: Reporting contextual update:', update);
    if (!update) return;
    const voice = getVoiceSession();
    console.log('🎤 Voice: Voice session:', voice);
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(update);
}

function reportSession(sessionId: string) {
    if (shownSessions.has(sessionId)) return;
    shownSessions.add(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!session) return;
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    const contextUpdate = formatSessionFull(session, messages);
    reportContextualUpdate(contextUpdate);
}

export const voiceHooks = {

    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
        // const voice = getVoiceSession();
        // if (!voice || !getCurrentRealtimeSessionId()) return;
        // reportSession(sessionId);
        // const contextUpdate = formatSessionOnline(sessionId, metadata);
        // voice.sendContextualUpdate(contextUpdate);
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
        // const voice = getVoiceSession();
        // if (!voice || !getCurrentRealtimeSessionId()) return;
        // reportSession(sessionId);
        // const contextUpdate = formatSessionOffline(sessionId, metadata);
        // voice.sendContextualUpdate(contextUpdate);
    },


    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
        reportSession(sessionId);
        reportContextualUpdate(formatSessionFocus(sessionId, metadata));
    },

    /**
     * Called when Claude requests permission for a tool use
     */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: any) {
        reportSession(sessionId);
        reportContextualUpdate(formatPermissionRequest(sessionId, requestId, toolName, toolArgs));
    },

    /**
     * Called when agent sends a message/response
     */
    onMessages(sessionId: string, messages: Message[]) {
        reportSession(sessionId);
        reportContextualUpdate(formatNewMessages(sessionId, messages));
    },

    /**
     * Called when voice session starts
     */
    onVoiceStarted(sessionId: string): string {
        console.log('🎤 Voice session started for:', sessionId);
        shownSessions.clear();
        let prompt = '';
        prompt += 'THIS IS AN ACTIVE SESSION: \n\n' + formatSessionFull(storage.getState().sessions[sessionId], storage.getState().sessionMessages[sessionId]?.messages ?? []);
        shownSessions.add(sessionId);
        // prompt += 'Another active sessions: \n\n';
        // for (let s of storage.getState().getActiveSessions()) {
        //     if (s.id === sessionId) continue;
        //     prompt += formatSessionFull(s, storage.getState().sessionMessages[s.id]?.messages ?? []);
        // }
        return prompt;
    },

    /**
     * Called when voice session stops
     */
    onVoiceStopped() {
        console.log('🎤 Voice session stopped');
        shownSessions.clear();
    }
};