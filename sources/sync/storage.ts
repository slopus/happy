import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { DecryptedMessage, Session } from "./storageTypes";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { normalizeRawMessage } from "./typesRaw";
import { isSessionActive, DISCONNECTED_TIMEOUT_MS } from '@/utils/sessionUtils';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases } from "./persistence";
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { messagesToPrompt } from '@/realtime/sessionToPrompt';

// Use the same timeout for both online status and disconnection detection

// Known entitlement IDs
export type KnownEntitlements = 'pro';

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
}

export type SessionListItem = string | Session;

interface DaemonStatus {
    machineId: string;
    online: boolean;
    lastSeen: number;
}

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    daemons: Record<string, DaemonStatus>;
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyLoaded: () => void;
    applyMessages: (sessionId: string, messages: DecryptedMessage[]) => void;
    applyMessagesLoaded: (sessionId: string) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    recalculateOnline: () => void;
    applyDaemonStatus: (machineId: string, status: 'online' | 'offline') => void;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
}

export const storage = create<StorageState>()((set) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        sessions: {},
        daemons: {},
        sessionsData: null,
        sessionMessages: {},
        realtimeStatus: 'disconnected',
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            const now = Date.now();
            const threshold = now - DISCONNECTED_TIMEOUT_MS;

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence
            sessions.forEach(session => {
                // Calculate presence based on active and activeAt
                const isOnline = session.active && session.activeAt > threshold;
                const presence: "online" | number = isOnline ? "online" : session.activeAt;

                mergedSessions[session.id] = {
                    ...session,
                    presence
                };
            });

            // Build active set from all sessions (including existing ones)
            // Use 30-second timeout for consistency with UI
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (isSessionActive(session)) {
                    activeSet.add(session.id);
                }
            });

            // Separate active and inactive sessions
            const activeSessions: Session[] = [];
            const inactiveSessions: Session[] = [];

            // Process all sessions from merged set
            Object.values(mergedSessions).forEach(session => {
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            // Sort both arrays by updatedAt
            activeSessions.sort((a, b) => b.updatedAt - a.updatedAt);
            inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // Process AgentState updates for sessions that already have messages loaded
            const updatedSessionMessages = { ...state.sessionMessages };
            
            sessions.forEach(session => {
                const oldSession = state.sessions[session.id];
                const newSession = mergedSessions[session.id];
                
                // Check if sessionMessages exists AND agentStateVersion is newer
                const existingSessionMessages = updatedSessionMessages[session.id];
                if (existingSessionMessages && newSession.agentState && 
                    (!oldSession || newSession.agentStateVersion > (oldSession.agentStateVersion || 0))) {
                    
                    // Check for NEW permission requests before processing
                    const currentRealtimeSessionId = getCurrentRealtimeSessionId();
                    const voiceSession = getVoiceSession();
                    
                    console.log('[REALTIME DEBUG] Permission check:', {
                        currentRealtimeSessionId,
                        sessionId: session.id,
                        match: currentRealtimeSessionId === session.id,
                        hasVoiceSession: !!voiceSession,
                        oldRequests: Object.keys(oldSession?.agentState?.requests || {}),
                        newRequests: Object.keys(newSession.agentState?.requests || {})
                    });
                    
                    if (currentRealtimeSessionId === session.id && voiceSession) {
                        const oldRequests = oldSession?.agentState?.requests || {};
                        const newRequests = newSession.agentState?.requests || {};
                        
                        // Find NEW permission requests only
                        for (const [requestId, request] of Object.entries(newRequests)) {
                            if (!oldRequests[requestId]) {
                                // This is a NEW permission request
                                const toolName = request.tool;
                                console.log('[REALTIME DEBUG] Sending permission notification for:', toolName);
                                voiceSession.sendTextMessage(
                                    `Claude is requesting permission to use the ${toolName} tool`
                                );
                            }
                        }
                    }
                    
                    // Process new AgentState through reducer
                    const processedMessages = reducer(existingSessionMessages.reducerState, [], newSession.agentState);
                    
                    // Always update the session messages, even if no new messages were created
                    // This ensures the reducer state is updated with the new AgentState
                    const mergedMessagesMap = { ...existingSessionMessages.messagesMap };
                    processedMessages.forEach(message => {
                        mergedMessagesMap[message.id] = message;
                    });
                    
                    const messagesArray = Object.values(mergedMessagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
                    
                    updatedSessionMessages[session.id] = {
                        messages: messagesArray,
                        messagesMap: mergedMessagesMap,
                        reducerState: existingSessionMessages.reducerState, // The reducer modifies state in-place, so this has the updates
                        isLoaded: existingSessionMessages.isLoaded
                    };
                }
            });

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,
                sessionMessages: updatedSessionMessages
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyMessages: (sessionId: string, messages: DecryptedMessage[]) => set((state) => {

            // Resolve session messages state
            const existingSession = state.sessionMessages[sessionId] || {
                messages: [],
                messagesMap: {},
                reducerState: createReducer(),
                isLoaded: false
            };

            // Get the session's agentState if available
            const session = state.sessions[sessionId];
            const agentState = session?.agentState;

            // Normalize messages
            let normalizedMessages = messages.map(m => normalizeRawMessage(m.id, m.localId, m.createdAt, m.content)).filter(m => m !== null);

            // Run reducer with agentState
            const processedMessages = reducer(existingSession.reducerState, normalizedMessages, agentState);

            // Send realtime updates for new messages if this is the active realtime session
            const currentRealtimeSessionId = getCurrentRealtimeSessionId();
            const voiceSession = getVoiceSession();
            console.log('[REALTIME DEBUG] Checking realtime updates:', {
                currentRealtimeSessionId,
                sessionId,
                match: currentRealtimeSessionId === sessionId,
                hasVoiceSession: !!voiceSession,
                processedMessagesCount: processedMessages.length
            });
            
            if (currentRealtimeSessionId === sessionId && voiceSession && processedMessages.length > 0) {
                // Filter for agent messages and tool calls only
                const agentMessages = processedMessages.filter(m => 
                    m.kind === 'agent-text' || m.kind === 'tool-call'
                );
                
                console.log('[REALTIME DEBUG] Agent messages found:', agentMessages.length, agentMessages.map(m => ({
                    kind: m.kind,
                    text: m.kind === 'agent-text' ? m.text : undefined,
                    tool: m.kind === 'tool-call' ? m.tool?.name : undefined
                })));
                
                if (agentMessages.length > 0) {
                    // Use the existing messagesToPrompt function to format properly
                    const contextUpdate = messagesToPrompt(agentMessages, {
                        maxCharacters: 1000,
                        excludeToolCalls: false
                    });
                    
                    console.log('[REALTIME DEBUG] Sending context update:', contextUpdate);
                    
                    if (contextUpdate.trim()) {
                        voiceSession.sendContextualUpdate(contextUpdate);
                    }
                }
            }

            // Merge messages
            const mergedMessagesMap = { ...existingSession.messagesMap };
            processedMessages.forEach(message => {
                mergedMessagesMap[message.id] = message;
            });

            // Convert to array and sort by createdAt
            const messagesArray = Object.values(mergedMessagesMap)
                .sort((a, b) => b.createdAt - a.createdAt);

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existingSession,
                        messages: messagesArray,
                        messagesMap: mergedMessagesMap,
                        isLoaded: true
                    }
                }
            };
        }),
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];
            let result: StorageState;

            if (!existingSession) {
                // First time loading - check for AgentState
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;
                
                // Create new reducer state
                const reducerState = createReducer();
                
                // Process AgentState if it exists
                let messages: Message[] = [];
                let messagesMap: Record<string, Message> = {};
                
                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const processedMessages = reducer(reducerState, [], agentState);
                    
                    processedMessages.forEach(message => {
                        messagesMap[message.id] = message;
                    });
                    
                    messages = Object.values(messagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
                }
                
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            reducerState,
                            messages,
                            messagesMap,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            } else {
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            }

            return result;
        }),
        recalculateOnline: () => set((state) => {
            const now = Date.now();
            const threshold = now - DISCONNECTED_TIMEOUT_MS;

            // Update presence for all sessions
            const updatedSessions: Record<string, Session> = {};
            Object.entries(state.sessions).forEach(([id, session]) => {
                const isOnline = session.active && session.activeAt > threshold;
                const isDisconnected = !session.activeAt || session.activeAt <= threshold;

                // Update session with presence and clear thinking/active if disconnected
                updatedSessions[id] = {
                    ...session,
                    presence: isOnline ? "online" : session.activeAt,
                    // Clear thinking and active states when disconnected
                    thinking: isDisconnected ? false : session.thinking,
                    active: isDisconnected ? false : session.active
                };
            });

            // Build set of session IDs that should be active
            // Use 30-second timeout for consistency with UI
            const shouldBeActiveSet = new Set<string>();
            Object.values(updatedSessions).forEach(session => {
                if (isSessionActive(session)) {
                    shouldBeActiveSet.add(session.id);
                }
            });

            // Build set of currently active session IDs
            const currentActiveSet = new Set<string>();
            if (state.sessionsData) {
                let inOnlineSection = false;
                for (const item of state.sessionsData) {
                    if (item === 'online') {
                        inOnlineSection = true;
                    } else if (item === 'offline') {
                        inOnlineSection = false;
                    } else if (typeof item !== 'string' && inOnlineSection) {
                        currentActiveSet.add(item.id);
                    }
                }
            }

            // Check if sets are equal
            if (shouldBeActiveSet.size === currentActiveSet.size &&
                [...shouldBeActiveSet].every(id => currentActiveSet.has(id))) {
                // No changes needed, return same state
                return state;
            }

            // Rebuild active and inactive lists
            const newActiveSessions: Session[] = [];
            const newInactiveSessions: Session[] = [];

            Object.values(updatedSessions).forEach(session => {
                if (shouldBeActiveSet.has(session.id)) {
                    newActiveSessions.push(session);
                } else {
                    newInactiveSessions.push(session);
                }
            });

            // Sort both arrays by updatedAt
            newActiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);
            newInactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (newActiveSessions.length > 0) {
                listData.push('online');
                listData.push(...newActiveSessions);
            }

            if (newInactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...newInactiveSessions);
            }

            return {
                ...state,
                sessions: updatedSessions,
                sessionsData: listData
            };
        }),
        applySettingsLocal: (settings: Partial<Settings>) => set((state) => {
            saveSettings(applySettings(state.settings, settings), state.settingsVersion ?? 0);
            return {
                ...state,
                settings: applySettings(state.settings, settings)
            };
        }),
        applySettings: (settings: Settings, version: number) => set((state) => {
            if (state.settingsVersion === null || state.settingsVersion < version) {
                saveSettings(settings, version);
                return {
                    ...state,
                    settings,
                    settingsVersion: version
                };
            } else {
                return state;
            }
        }),
        applyLocalSettings: (delta: Partial<LocalSettings>) => set((state) => {
            const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
            saveLocalSettings(updatedLocalSettings);
            return {
                ...state,
                localSettings: updatedLocalSettings
            };
        }),
        applyPurchases: (customerInfo: CustomerInfo) => set((state) => {
            // Transform CustomerInfo to our Purchases format
            const purchases = customerInfoToPurchases(customerInfo);
            
            // Always save and update - no need for version checks
            savePurchases(purchases);
            return {
                ...state,
                purchases
            };
        }),
        applyDaemonStatus: (machineId: string, status: 'online' | 'offline') => set((state) => {
            const now = Date.now();
            if (status === 'online') {
                return {
                    ...state,
                    daemons: {
                        ...state.daemons,
                        [machineId]: {
                            machineId,
                            online: true,
                            lastSeen: now
                        }
                    }
                };
            } else {
                // Remove offline daemons
                const { [machineId]: removed, ...remainingDaemons } = state.daemons;
                return {
                    ...state,
                    daemons: remainingDaemons
                };
            }
        }),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.sessionsData));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: Message[] = [];

export function useSessionMessages(sessionId: string): { messages: Message[], isLoaded: boolean } {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray,
            isLoaded: session?.isLoaded ?? false
        };
    }));
}

export function useMessage(sessionId: string, messageId: string): Message | null {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.messagesMap[messageId] ?? null;
    }));
}

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const setValue = React.useCallback((value: Settings[K]) => {
        sync.applySettings({ [name]: value });
    }, [name]);
    const value = useSetting(name);
    return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export function useDaemonStatus(): DaemonStatus | null {
    return storage(useShallow((state) => {
        // Return the first online daemon if any
        const onlineDaemons = Object.values(state.daemons).filter(d => d.online);
        return onlineDaemons.length > 0 ? onlineDaemons[0] : null;
    }));
}

export function useAllDaemonStatuses(): DaemonStatus[] {
    return storage(useShallow((state) => {
        // Return all online daemons
        return Object.values(state.daemons).filter(d => d.online);
    }));
}

export function useDaemonStatusByMachine(machineId: string): DaemonStatus | null {
    return storage(useShallow((state) => {
        const daemon = state.daemons[machineId];
        return daemon?.online ? daemon : null;
    }));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    const value = useLocalSetting(name);
    return [value, setValue];
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

export function useEntitlement(id: KnownEntitlements): boolean {
    return storage(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return storage(useShallow((state) => state.realtimeStatus));
}