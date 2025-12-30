import React from 'react';
import { View, Text, Platform, Pressable, useWindowDimensions } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, storage, useSetting } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { AgentInput } from '@/components/AgentInput';
import { MultiTextInputHandle } from '@/components/MultiTextInput';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { machineSpawnNewSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { createWorktree } from '@/utils/createWorktree';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import { linkTaskToSession } from '@/-zen/model/taskSessionLink';
import { PermissionMode } from '@/components/PermissionModeSelector';
import { clearNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';

// Helper function to get the most recent path for a machine from settings or sessions
const getRecentPathForMachine = (machineId: string | null, recentPaths: Array<{ machineId: string; path: string }>): string => {
    if (!machineId) return '/home/';

    // First check recent paths from settings
    const recentPath = recentPaths.find(rp => rp.machineId === machineId);
    if (recentPath) {
        return recentPath.path;
    }

    // Fallback to session history
    const machine = storage.getState().machines[machineId];
    const defaultPath = machine?.metadata?.homeDir || '/home/';

    const sessions = Object.values(storage.getState().sessions);
    const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];
    const pathSet = new Set<string>();

    sessions.forEach(session => {
        if (session.metadata?.machineId === machineId && session.metadata?.path) {
            const path = session.metadata.path;
            if (!pathSet.has(path)) {
                pathSet.add(path);
                pathsWithTimestamps.push({
                    path,
                    timestamp: session.updatedAt || session.createdAt
                });
            }
        }
    });

    // Sort by most recent first
    pathsWithTimestamps.sort((a, b) => b.timestamp - a.timestamp);

    return pathsWithTimestamps[0]?.path || defaultPath;
};

// Helper function to update recent machine paths
const updateRecentMachinePaths = (
    currentPaths: Array<{ machineId: string; path: string }>,
    machineId: string,
    path: string
): Array<{ machineId: string; path: string }> => {
    // Remove any existing entry for this machine
    const filtered = currentPaths.filter(rp => rp.machineId !== machineId);
    // Add new entry at the beginning
    const updated = [{ machineId, path }, ...filtered];
    // Keep only the last 10 entries
    return updated.slice(0, 10);
};

function NewSessionScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { prompt, dataId, machineId: machineIdParam, path: pathParam } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
    }>();

    // Try to get data from temporary store first, fallback to direct prompt parameter
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);

    const persistedDraft = React.useRef(loadNewSessionDraft()).current;

    const [input, setInput] = React.useState(() => {
        if (tempSessionData?.prompt) {
            return tempSessionData.prompt;
        }
        return prompt || persistedDraft?.input || '';
    });
    const [isSending, setIsSending] = React.useState(false);
    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>(() => {
        if (tempSessionData?.sessionType) {
            return tempSessionData.sessionType;
        }
        return persistedDraft?.sessionType || 'simple';
    });
    const ref = React.useRef<MultiTextInputHandle>(null);
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    const screenWidth = useWindowDimensions().width;

    // Load recent machine paths and last used agent from settings
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const experimentsEnabled = useSetting('experiments');

    //
    // Machines state
    //

    const machines = useAllMachines();
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => {
        const machineIdFromDraft = tempSessionData?.machineId ?? persistedDraft?.selectedMachineId;
        if (machineIdFromDraft) {
            return machineIdFromDraft;
        }
        if (machines.length > 0) {
            // Check if we have a recently used machine that's currently available
            if (recentMachinePaths.length > 0) {
                // Find the first machine from recent paths that's currently available
                for (const recent of recentMachinePaths) {
                    if (machines.find(m => m.id === recent.machineId)) {
                        return recent.machineId;
                    }
                }
            }
            // Fallback to first machine if no recent machine is available
            return machines[0].id;
        }
        return null;
    });
    React.useEffect(() => {
        if (machines.length > 0) {
            if (!selectedMachineId) {
                // No machine selected yet, prefer the most recently used machine
                let machineToSelect = machines[0].id; // Default to first machine

                // Check if we have a recently used machine that's currently available
                if (recentMachinePaths.length > 0) {
                    for (const recent of recentMachinePaths) {
                        if (machines.find(m => m.id === recent.machineId)) {
                            machineToSelect = recent.machineId;
                            break; // Use the first (most recent) match
                        }
                    }
                }

                setSelectedMachineId(machineToSelect);
                // Also set the best path for the selected machine
                const bestPath = getRecentPathForMachine(machineToSelect, recentMachinePaths);
                setSelectedPath(bestPath);
            } else {
                // Machine is already selected, but check if we need to update path
                // This handles the case where machines load after initial render
                const currentMachine = machines.find(m => m.id === selectedMachineId);
                if (!currentMachine) {
                    // Selected machine doesn't exist anymore - fall back safely
                    const fallbackMachineId = machines[0].id;
                    setSelectedMachineId(fallbackMachineId);
                    const bestPath = getRecentPathForMachine(fallbackMachineId, recentMachinePaths);
                    setSelectedPath(bestPath);
                    return;
                }

                // Update path based on recent paths (only if path hasn't been manually changed)
                const bestPath = getRecentPathForMachine(selectedMachineId, recentMachinePaths);
                setSelectedPath(prevPath => {
                    // Only update if current path is the default /home/
                    if (prevPath === '/home/' && bestPath !== '/home/') {
                        return bestPath;
                    }
                    return prevPath;
                });
            }
        }
    }, [machines, selectedMachineId, recentMachinePaths]);

    React.useEffect(() => {
        if (typeof machineIdParam !== 'string' || machines.length === 0) {
            return;
        }
        // Only accept machineId if it exists in the current machines list
        if (!machines.some(m => m.id === machineIdParam)) {
            return;
        }
        if (machineIdParam !== selectedMachineId) {
            setSelectedMachineId(machineIdParam);
            const bestPath = getRecentPathForMachine(machineIdParam, recentMachinePaths);
            setSelectedPath(bestPath);
        }
    }, [machineIdParam, machines, recentMachinePaths, selectedMachineId]);

    React.useEffect(() => {
        if (typeof pathParam !== 'string') {
            return;
        }
        const trimmedPath = pathParam.trim();
        if (!trimmedPath) {
            return;
        }
        setSelectedPath(trimmedPath);
    }, [pathParam]);

    const handleMachineClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/machine',
            params: selectedMachineId ? { selectedId: selectedMachineId } : {},
        });
    }, [router, selectedMachineId]);

    //
    // Agent selection
    //

    const [agentType, setAgentType] = React.useState<'claude' | 'codex' | 'gemini'>(() => {
        // Check if agent type was provided in temp data
        if (tempSessionData?.agentType) {
            // Only allow gemini if experiments are enabled
            if (tempSessionData.agentType === 'gemini' && !experimentsEnabled) {
                return 'claude';
            }
            return tempSessionData.agentType;
        }
        // Use persisted draft if available
        if (persistedDraft?.agentType) {
            if (persistedDraft.agentType === 'gemini' && !experimentsEnabled) {
                return 'claude';
            }
            return persistedDraft.agentType;
        }
        // Initialize with last used agent if valid, otherwise default to 'claude'
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex') {
            return lastUsedAgent;
        }
        // Only allow gemini if experiments are enabled
        if (lastUsedAgent === 'gemini' && experimentsEnabled) {
            return lastUsedAgent;
        }
        return 'claude';
    });

    const handleAgentClick = React.useCallback(() => {
        setAgentType(prev => {
            // Cycle: claude -> codex -> gemini (if experiments) -> claude
            let newAgent: 'claude' | 'codex' | 'gemini';
            if (prev === 'claude') {
                newAgent = 'codex';
            } else if (prev === 'codex') {
                newAgent = experimentsEnabled ? 'gemini' : 'claude';
            } else {
                newAgent = 'claude';
            }
            // Save the new selection immediately
            sync.applySettings({ lastUsedAgent: newAgent });
            return newAgent;
        });
    }, [experimentsEnabled]);

    //
    // Permission Mode selection
    //

    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        // Initialize with last used permission mode if valid, otherwise default to 'default'
        const validClaudeGeminiModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        const permissionModeFromDraft = persistedDraft?.permissionMode ?? lastUsedPermissionMode;
        if (permissionModeFromDraft) {
            if (agentType === 'codex' && validCodexModes.includes(permissionModeFromDraft as PermissionMode)) {
                return permissionModeFromDraft as PermissionMode;
            } else if ((agentType === 'claude' || agentType === 'gemini') && validClaudeGeminiModes.includes(permissionModeFromDraft as PermissionMode)) {
                return permissionModeFromDraft as PermissionMode;
            }
        }
        return 'default';
    });

    // Reset permission mode when agent type changes
    const hasMountedRef = React.useRef(false);
    React.useEffect(() => {
        if (!hasMountedRef.current) {
            hasMountedRef.current = true;
            return;
        }
        setPermissionMode('default');
    }, [agentType]);

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        setPermissionMode(mode);
        // Save the new selection immediately
        sync.applySettings({ lastUsedPermissionMode: mode });
    }, []);

    //
    // Path selection
    //

    const [selectedPath, setSelectedPath] = React.useState<string>(() => {
        // Initialize with the path from the selected machine (which should be the most recent if available)
        const pathFromDraft = tempSessionData?.path ?? persistedDraft?.selectedPath;
        if (pathFromDraft) {
            return pathFromDraft;
        }
        return getRecentPathForMachine(selectedMachineId, recentMachinePaths);
    });
    const handlePathClick = React.useCallback(() => {
        if (selectedMachineId) {
            router.push({
                pathname: '/new/pick/path',
                params: {
                    machineId: selectedMachineId,
                    selectedPath,
                },
            });
        }
    }, [selectedMachineId, selectedPath, router]);

    // Get selected machine name
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId);
    }, [selectedMachineId, machines]);

    // Autofocus
    React.useLayoutEffect(() => {
        if (Platform.OS === 'ios') {
            setTimeout(() => {
                ref.current?.focus();
            }, 800);
        } else {
            ref.current?.focus();
        }
    }, []);

    // Create
    const doCreate = React.useCallback(async () => {
        if (!selectedMachineId) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            return;
        }
        if (!selectedPath) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            return;
        }

        setIsSending(true);
        try {
            let actualPath = selectedPath;
            
            // Handle worktree creation if selected and experiments are enabled
            if (sessionType === 'worktree' && experimentsEnabled) {
                const worktreeResult = await createWorktree(selectedMachineId, selectedPath);
                
                if (!worktreeResult.success) {
                    if (worktreeResult.error === 'Not a Git repository') {
                        Modal.alert(
                            t('common.error'), 
                            t('newSession.worktree.notGitRepo')
                        );
                    } else {
                        Modal.alert(
                            t('common.error'), 
                            t('newSession.worktree.failed', { error: worktreeResult.error || 'Unknown error' })
                        );
                    }
                    setIsSending(false);
                    return;
                }
                
                // Update the path to the new worktree location
                actualPath = worktreeResult.worktreePath;
            }

            // Save the machine-path combination to settings before sending
            const updatedPaths = updateRecentMachinePaths(recentMachinePaths, selectedMachineId, selectedPath);
            sync.applySettings({ recentMachinePaths: updatedPaths });

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: actualPath,
                // For now we assume you already have a path to start in
                approvedNewDirectoryCreation: true,
                agent: agentType
            });

            // Use sessionId to check for success for backwards compatibility
            if ('sessionId' in result && result.sessionId) {
                clearNewSessionDraft();
                // Store worktree metadata if applicable
                if (sessionType === 'worktree') {
                    // The metadata will be stored by the session itself once created
                }

                // Link task to session if task ID is provided
                if (tempSessionData?.taskId && tempSessionData?.taskTitle) {
                    const promptDisplayTitle = tempSessionData.prompt?.startsWith('Work on this task:')
                        ? `Work on: ${tempSessionData.taskTitle}`
                        : `Clarify: ${tempSessionData.taskTitle}`;
                    await linkTaskToSession(
                        tempSessionData.taskId,
                        result.sessionId,
                        tempSessionData.taskTitle,
                        promptDisplayTitle
                    );
                }

                // Load sessions
                await sync.refreshSessions();

                // Set permission mode on the session
                storage.getState().updateSessionPermissionMode(result.sessionId, permissionMode);

                // Send message
                await sync.sendMessage(result.sessionId, input);
                // Navigate to session
                router.replace(`/session/${result.sessionId}`, {
                    dangerouslySingular() {
                        return 'session'
                    },
                });
            } else {
                throw new Error('Session spawning failed - no session ID returned.');
            }
        } catch (error) {
            console.error('Failed to start session', error);

            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }

            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSending(false);
        }
    }, [agentType, selectedMachineId, selectedPath, input, recentMachinePaths, sessionType, experimentsEnabled, permissionMode]);

    // Persist the current modal state so it survives remounts and reopen/close
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
        }
        draftSaveTimerRef.current = setTimeout(() => {
            saveNewSessionDraft({
                input,
                selectedMachineId,
                selectedPath,
                agentType,
                permissionMode,
                sessionType,
                updatedAt: Date.now(),
            });
        }, 250);
        return () => {
            if (draftSaveTimerRef.current) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [input, selectedMachineId, selectedPath, agentType, permissionMode, sessionType]);

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight + safeArea.bottom + 16 : 0}
            style={{
                flex: 1,
                justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
                paddingTop: Platform.OS === 'web' ? 0 : 40,
            }}
        >
            <View style={{
                width: '100%',
                alignSelf: 'center',
                paddingTop: safeArea.top,
                paddingBottom: safeArea.bottom,
            }}>
                {/* Session type selector - only show when experiments are enabled */}
                {experimentsEnabled && (
                    <View style={[
                        { paddingHorizontal: screenWidth > 700 ? 16 : 8, flexDirection: 'row', justifyContent: 'center' }
                    ]}>
                        <View style={[
                            { maxWidth: layout.maxWidth, flex: 1 }
                        ]}>
                            <SessionTypeSelector 
                                value={sessionType}
                                onChange={setSessionType}
                            />
                        </View>
                    </View>
                )}

                {/* Agent input */}
                <AgentInput
                    placeholder={t('session.inputPlaceholder')}
                    ref={ref}
                    value={input}
                    onChangeText={setInput}
                    onSend={doCreate}
                    isSending={isSending}
                    agentType={agentType}
                    onAgentClick={handleAgentClick}
                    machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || null}
                    onMachineClick={handleMachineClick}
                    permissionMode={permissionMode}
                    onPermissionModeChange={handlePermissionModeChange}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />

                <View style={[
                    { paddingHorizontal: screenWidth > 700 ? 16 : 8, flexDirection: 'row', justifyContent: 'center' }
                ]}>
                    <View style={[
                        { maxWidth: layout.maxWidth, flex: 1 }
                    ]}>
                        <Pressable
                            onPress={handlePathClick}
                            style={(p) => ({
                                backgroundColor: theme.colors.input.background,
                                borderRadius: Platform.select({ default: 16, android: 20 }),
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                marginBottom: 8,
                                flexDirection: 'row',
                                alignItems: 'center',
                                opacity: p.pressed ? 0.7 : 1,
                            })}
                        >
                            <Ionicons
                                name="folder-outline"
                                size={14}
                                color={theme.colors.button.secondary.tint}
                            />
                            <Text style={{
                                fontSize: 13,
                                color: theme.colors.button.secondary.tint,
                                fontWeight: '600',
                                marginLeft: 6,
                                ...Typography.default('semiBold'),
                            }}>
                                {selectedPath}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    )
}

export default React.memo(NewSessionScreen);
