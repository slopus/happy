import React from 'react';
import { View, Text } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { machineSpawnNewSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { createWorktree } from '@/utils/createWorktree';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import { linkTaskToSession } from '@/-zen/model/taskSessionLink';
import { PermissionMode, ModelMode } from '@/components/PermissionModeSelector';
import { NewSessionWizard } from '@/components/NewSessionWizard';
import { AgentInput } from '@/components/AgentInput';
import { MultiTextInputHandle } from '@/components/MultiTextInput';
import { storage, useSetting } from '@/sync/storage';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { Platform } from 'react-native';

// Simple temporary state for passing selections back from picker screens
let onMachineSelected: (machineId: string) => void = () => { };
export const callbacks = {
    onMachineSelected: (machineId: string) => {
        onMachineSelected(machineId);
    }
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    wizardContainer: {
        flex: 1,
    },
    promptContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    promptLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 12,
        ...Typography.default('semiBold'),
    },
}));

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
    const styles = stylesheet;
    const router = useRouter();
    const { prompt, dataId } = useLocalSearchParams<{ prompt?: string; dataId?: string }>();

    // Try to get data from temporary store first, fallback to direct prompt parameter
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);

    const [showWizard, setShowWizard] = React.useState(true);
    const [wizardConfig, setWizardConfig] = React.useState<{
        sessionType: 'simple' | 'worktree';
        agentType: 'claude' | 'codex';
        permissionMode: PermissionMode;
        modelMode: ModelMode;
        machineId: string;
        path: string;
        prompt: string;
    } | null>(null);

    const [input, setInput] = React.useState(() => {
        if (tempSessionData?.prompt) {
            return tempSessionData.prompt;
        }
        return prompt || '';
    });
    const [isSending, setIsSending] = React.useState(false);
    const ref = React.useRef<MultiTextInputHandle>(null);
    const recentMachinePaths = useSetting('recentMachinePaths');
    const experimentsEnabled = useSetting('experiments');

    // Autofocus
    React.useLayoutEffect(() => {
        if (!showWizard) {
            if (Platform.OS === 'ios') {
                setTimeout(() => {
                    ref.current?.focus();
                }, 800);
            } else {
                ref.current?.focus();
            }
        }
    }, [showWizard]);

    const handleWizardComplete = (config: {
        sessionType: 'simple' | 'worktree';
        agentType: 'claude' | 'codex';
        permissionMode: PermissionMode;
        modelMode: ModelMode;
        machineId: string;
        path: string;
        prompt: string;
    }) => {
        setWizardConfig(config);
        setInput(config.prompt);

        // Save settings
        sync.applySettings({
            lastUsedAgent: config.agentType,
            lastUsedPermissionMode: config.permissionMode,
            lastUsedModelMode: config.modelMode,
        });

        // Directly create the session since we have all the info
        doCreate(config);
    };

    const handleWizardCancel = () => {
        router.back();
    };

    // Create session
    const doCreate = React.useCallback(async (config?: {
        sessionType: 'simple' | 'worktree';
        agentType: 'claude' | 'codex';
        permissionMode: PermissionMode;
        modelMode: ModelMode;
        machineId: string;
        path: string;
        prompt: string;
    }) => {
        const activeConfig = config || wizardConfig;
        if (!activeConfig) {
            Modal.alert(t('common.error'), 'Configuration not set');
            return;
        }

        setIsSending(true);
        try {
            let actualPath = activeConfig.path;

            // Handle worktree creation if selected and experiments are enabled
            if (activeConfig.sessionType === 'worktree' && experimentsEnabled) {
                const worktreeResult = await createWorktree(activeConfig.machineId, activeConfig.path);

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
            const updatedPaths = updateRecentMachinePaths(recentMachinePaths, activeConfig.machineId, activeConfig.path);
            sync.applySettings({ recentMachinePaths: updatedPaths });

            const result = await machineSpawnNewSession({
                machineId: activeConfig.machineId,
                directory: actualPath,
                // For now we assume you already have a path to start in
                approvedNewDirectoryCreation: true,
                agent: activeConfig.agentType
            });

            // Use sessionId to check for success for backwards compatibility
            if ('sessionId' in result && result.sessionId) {
                // Store worktree metadata if applicable
                if (activeConfig.sessionType === 'worktree') {
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

                // Set permission and model modes on the session
                storage.getState().updateSessionPermissionMode(result.sessionId, activeConfig.permissionMode);
                storage.getState().updateSessionModelMode(result.sessionId, activeConfig.modelMode);

                // Send message
                await sync.sendMessage(result.sessionId, activeConfig.prompt);
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
    }, [recentMachinePaths, experimentsEnabled, tempSessionData, router]);

    if (showWizard) {
        return (
            <View style={styles.container}>
                <View style={styles.wizardContainer}>
                    <NewSessionWizard
                        onComplete={handleWizardComplete}
                        onCancel={handleWizardCancel}
                        initialPrompt={input}
                    />
                </View>
            </View>
        );
    }

    // This should not render since wizard creates session directly
    return null;
}

export default React.memo(NewSessionScreen);