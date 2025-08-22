import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { Session, Machine, GitStatus } from "./storageTypes";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes } from "./persistence";
import type { PermissionMode } from '@/components/PermissionModeSelector';
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";

// Timeout for considering a session disconnected (2 minutes)
const DISCONNECTED_TIMEOUT_MS = 120000;

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    const now = Date.now();
    const threshold = now - DISCONNECTED_TIMEOUT_MS;
    
    // Session is online if it's active and was seen recently
    const isOnline = session.active && session.activeAt > threshold;
    
    return isOnline ? "online" : session.activeAt;
}

/**
 * Checks if a session should be shown in the active sessions group
 */
function isSessionActive(session: { active: boolean; activeAt: number }): boolean {
    const now = Date.now();
    return session.active && !!session.activeAt && (session.activeAt >= now - DISCONNECTED_TIMEOUT_MS);
}

// Known entitlement IDs
export type KnownEntitlements = 'pro';

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
}

// Machine type is now imported from storageTypes - represents persisted machine data

// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: Session[] }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'session'; session: Session; variant?: 'default' | 'no-path' };

// Legacy type for backward compatibility - to be removed
export type SessionListItem = string | Session;

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;  // Legacy - to be removed
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    sessionGitStatus: Record<string, GitStatus | null>;
    machines: Record<string, Machine>;
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    isDataReady: boolean;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => string[];
    applyMessagesLoaded: (sessionId: string) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    recalculateOnline: () => void;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => void;
    updateSessionModelMode: (sessionId: string, mode: 'default' | 'adaptiveUsage' | 'sonnet' | 'opus') => void;
}

// Helper function to build unified list view data from sessions and machines
function buildSessionListViewData(
    sessions: Record<string, Session>
): SessionListViewItem[] {
    // Separate all sessions into active and inactive
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];

    Object.values(sessions).forEach(session => {
        if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    // Sort active sessions by creation date (newest first)
    activeSessions.sort((a, b) => b.createdAt - a.createdAt);
    
    // Sort inactive sessions by creation date (newest first)
    inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

    // Build unified list view data
    const listData: SessionListViewItem[] = [];

    // Add active sessions as a single item at the top (if any)
    if (activeSessions.length > 0) {
        listData.push({ type: 'active-sessions', sessions: activeSessions });
    }

    // Add previous sessions header if we have any inactive sessions
    if (inactiveSessions.length > 0) {
        listData.push({ type: 'header', title: 'Previous Sessions' });
        
        // Add all inactive sessions individually (no grouping)
        inactiveSessions.forEach(session =>
            listData.push({ type: 'session', session })
        );
    }

    return listData;
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        sessions: {},
        machines: {},
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionMessages: {},
        sessionGitStatus: {},
        realtimeStatus: 'disconnected',
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        isMutableToolCall: (sessionId: string, callId: string) => {
            const sessionMessages = get().sessionMessages[sessionId];
            if (!sessionMessages) {
                return true;
            }
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
            if (!toolCallMessage || toolCallMessage.kind !== 'tool-call') {
                return true;
            }
            return toolCallMessage.tool?.name ? isMutableTool(toolCallMessage.tool?.name) : true;
        },
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            // Load drafts and permission modes if sessions are empty (initial load)
            const savedDrafts = Object.keys(state.sessions).length === 0 ? sessionDrafts : {};
            const savedPermissionModes = Object.keys(state.sessions).length === 0 ? sessionPermissionModes : {};

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];
                const existingPermissionMode = state.sessions[session.id]?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: existingPermissionMode || savedPermissionMode || session.permissionMode || 'default'
                };
            });

            // Build active set from all sessions (including existing ones)
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

            // Sort both arrays by creation date for stable ordering
            activeSessions.sort((a, b) => b.createdAt - a.createdAt);
            inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // console.log(`📊 Storage: applySessions called with ${sessions.length} sessions, active: ${activeSessions.length}, inactive: ${inactiveSessions.length}`);

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

                    // console.log('[REALTIME DEBUG] Permission check:', {
                    //     currentRealtimeSessionId,
                    //     sessionId: session.id,
                    //     match: currentRealtimeSessionId === session.id,
                    //     hasVoiceSession: !!voiceSession,
                    //     oldRequests: Object.keys(oldSession?.agentState?.requests || {}),
                    //     newRequests: Object.keys(newSession.agentState?.requests || {})
                    // });

                    if (currentRealtimeSessionId === session.id && voiceSession) {
                        const oldRequests = oldSession?.agentState?.requests || {};
                        const newRequests = newSession.agentState?.requests || {};

                        // Find NEW permission requests only
                        for (const [requestId, request] of Object.entries(newRequests)) {
                            if (!oldRequests[requestId]) {
                                // This is a NEW permission request
                                const toolName = request.tool;
                                // console.log('[REALTIME DEBUG] Sending permission notification for:', toolName);
                                voiceSession.sendTextMessage(
                                    `Claude is requesting permission to use the ${toolName} tool`
                                );
                            }
                        }
                    }

                    // Process new AgentState through reducer
                    const reducerResult = reducer(existingSessionMessages.reducerState, [], newSession.agentState);
                    const processedMessages = reducerResult.messages;

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

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                mergedSessions
            );

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData,
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
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
        applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
            let changed = new Set<string>();
            set((state) => {

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

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;

                // Run reducer with agentState
                const reducerResult = reducer(existingSession.reducerState, normalizedMessages, agentState);
                const processedMessages = reducerResult.messages;
                for(let message of processedMessages) {
                    changed.add(message.id);
                }

                // Merge messages
                const mergedMessagesMap = { ...existingSession.messagesMap };
                processedMessages.forEach(message => {
                    mergedMessagesMap[message.id] = message;
                });

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort((a, b) => b.createdAt - a.createdAt);

                // Update session with todos if they changed
                let updatedSessions = state.sessions;
                if (reducerResult.todos && session) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            todos: reducerResult.todos
                        }
                    };
                }

                return {
                    ...state,
                    sessions: updatedSessions,
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
            });

            return Array.from(changed);
        },
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
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

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

            // Update presence for all sessions using centralized resolver
            const updatedSessions: Record<string, Session> = {};
            Object.entries(state.sessions).forEach(([id, session]) => {
                const isDisconnected = !session.activeAt || session.activeAt <= threshold;

                // Update session with presence and clear thinking/active if disconnected
                updatedSessions[id] = {
                    ...session,
                    presence: resolveSessionOnlineState(session),
                    // Clear thinking and active states when disconnected
                    thinking: isDisconnected ? false : session.thinking,
                    active: isDisconnected ? false : session.active
                };
            });

            // Build set of session IDs that should be active
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

            // Check if active/inactive categorization has changed
            const setsAreEqual = shouldBeActiveSet.size === currentActiveSet.size &&
                [...shouldBeActiveSet].every(id => currentActiveSet.has(id));

            // Always update sessions to ensure presence changes trigger re-renders
            // Only skip rebuilding sessionsData if categorization hasn't changed
            if (setsAreEqual) {
                // Build new unified list view data with updated sessions
                const sessionListViewData = buildSessionListViewData(
                    updatedSessions
                );

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionListViewData
                };
            }

            // Rebuild active and inactive lists when categorization has changed
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

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData

            if (newInactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...newInactiveSessions);
            }

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                updatedSessions
            );

            return {
                ...state,
                sessions: updatedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData
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
        applyGitStatus: (sessionId: string, status: GitStatus | null) => set((state) => ({
            ...state,
            sessionGitStatus: {
                ...state.sessionGitStatus,
                [sessionId]: status
            }
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => {
            const now = Date.now();
            const updates: Partial<StorageState> = {
                socketStatus: status
            };

            // Update timestamp based on status
            if (status === 'connected') {
                updates.socketLastConnectedAt = now;
            } else if (status === 'disconnected' || status === 'error') {
                updates.socketLastDisconnectedAt = now;
            }

            return {
                ...state,
                ...updates
            };
        }),
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Collect all drafts for persistence
            const allDrafts: Record<string, string> = {};
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (id === sessionId) {
                    if (normalizedDraft) {
                        allDrafts[id] = normalizedDraft;
                    }
                } else if (sess.draft) {
                    allDrafts[id] = sess.draft;
                }
            });

            // Persist drafts
            saveSessionDrafts(allDrafts);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    draft: normalizedDraft
                }
            };

            // Rebuild sessionListViewData to update the UI immediately
            const sessionListViewData = buildSessionListViewData(
                updatedSessions
            );

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
        }),
        updateSessionPermissionMode: (sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: mode
                }
            };

            // Collect all permission modes for persistence
            const allModes: Record<string, PermissionMode> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.permissionMode && sess.permissionMode !== 'default') {
                    allModes[id] = sess.permissionMode;
                }
            });

            // Persist permission modes (only non-default values to save space)
            saveSessionPermissionModes(allModes);

            // No need to rebuild sessionListViewData since permission mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionModelMode: (sessionId: string, mode: 'default' | 'adaptiveUsage' | 'sonnet' | 'opus') => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Update the session with the new model mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    modelMode: mode
                }
            };

            // No need to rebuild sessionListViewData since model mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        applyMachines: (machines: Machine[], replace: boolean = false) => set((state) => {
            // Either replace all machines or merge updates
            let mergedMachines: Record<string, Machine>;
            
            if (replace) {
                // Replace entire machine state (used by fetchMachines)
                mergedMachines = {};
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            } else {
                // Merge individual updates (used by update-machine)
                mergedMachines = { ...state.machines };
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            }
            
            // Rebuild sessionListViewData to reflect machine changes
            const sessionListViewData = buildSessionListViewData(
                state.sessions
            );
            
            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

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

export function useSessionUsage(sessionId: string) {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.reducerState?.latestUsage ?? null;
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

export function useAllMachines(): Machine[] {
    const m = storage((state) => state.machines);
    return React.useMemo(() => Object.values(m).sort((a, b) => b.id.localeCompare(a.id)), [m]);
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage((state) => state.isDataReady ? state.sessionListViewData : null);
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

export function useSocketStatus() {
    return storage(useShallow((state) => ({
        status: state.socketStatus,
        lastConnectedAt: state.socketLastConnectedAt,
        lastDisconnectedAt: state.socketLastDisconnectedAt
    })));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
    return storage(useShallow((state) => state.sessionGitStatus[sessionId] ?? null));
}

export function useIsDataReady(): boolean {
    return storage(useShallow((state) => state.isDataReady));
}