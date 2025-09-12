import React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, storage } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { AgentInput } from '@/components/AgentInput';
import { MultiTextInputHandle } from '@/components/MultiTextInput';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { machineSpawnNewSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { sync } from '@/sync/sync';

// Simple temporary state for passing selections back from picker screens
let onMachineSelected: (machineId: string) => void = () => { };
let onPathSelected: (path: string) => void = () => { };
export const callbacks = {
    onMachineSelected: (machineId: string) => {
        onMachineSelected(machineId);
    },
    onPathSelected: (path: string) => {
        onPathSelected(path);
    }
}

// Helper function to get the most recent path for a machine
const getRecentPathForMachine = (machineId: string | null): string => {
    if (!machineId) return '~';

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

    return pathsWithTimestamps[0]?.path || '~';
};

export default function NewSessionScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    const [input, setInput] = React.useState('');
    const [isSending, setIsSending] = React.useState(false);
    const ref = React.useRef<MultiTextInputHandle>(null);
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();


    //
    // Machines state
    //

    const machines = useAllMachines();
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => {
        if (machines.length > 0) {
            return machines[0].id;
        }
        return null;
    });
    React.useEffect(() => {
        if (machines.length > 0 && !selectedMachineId) {
            const firstMachineId = machines[0].id;
            setSelectedMachineId(firstMachineId);
            // Also set the best path for the initially selected machine
            const bestPath = getRecentPathForMachine(firstMachineId);
            setSelectedPath(bestPath);
        }
    }, [machines, selectedMachineId]);

    React.useEffect(() => {
        let handler = (machineId: string) => {
            let machine = storage.getState().machines[machineId];
            if (machine) {
                setSelectedMachineId(machineId);
                // Also update the path when machine changes
                const bestPath = getRecentPathForMachine(machineId);
                setSelectedPath(bestPath);
            }
        };
        onMachineSelected = handler;
        return () => {
            onMachineSelected = () => { };
        };
    }, []);

    React.useEffect(() => {
        let handler = (path: string) => {
            setSelectedPath(path);
        };
        onPathSelected = handler;
        return () => {
            onPathSelected = () => { };
        };
    }, []);

    const handleMachineClick = React.useCallback(() => {
        router.push('/new/pick/machine');
    }, []);

    //
    // Agent selection
    //

    const [agentType, setAgentType] = React.useState<'claude' | 'codex'>('claude');
    const handleAgentClick = React.useCallback(() => {
        setAgentType(prev => prev === 'claude' ? 'codex' : 'claude');
    }, []);

    //
    // Path selection
    //

    const [selectedPath, setSelectedPath] = React.useState<string>(() =>
        getRecentPathForMachine(selectedMachineId)
    );
    const handlePathClick = React.useCallback(() => {
        if (selectedMachineId) {
            router.push(`/new/pick/path?machineId=${selectedMachineId}`);
        }
    }, [selectedMachineId, router]);

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
            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: selectedPath,
                // For now we assume you already have a path to start in
                approvedNewDirectoryCreation: true
            });

            // Use sessionId to check for success for backwards compatibility
            if ('sessionId' in result && result.sessionId) {
                // Load sessions
                await sync.refreshSessions();
                // Send message
                await sync.sendMessage(result.sessionId, input);
                // Navigate to session
                router.replace(`/session/${result.sessionId}`, {
                    dangerouslySingular(name, params) {
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
    }, [agentType, selectedMachineId, selectedPath, input]);

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Constants.statusBarHeight + headerHeight}
            style={{
                flex: 1,
                justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
                paddingTop: Platform.OS === 'web' ? 0 : 40,
                marginBottom: safeArea.bottom,
            }}
        >
            <View style={{
                width: '100%',
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                paddingTop: safeArea.top,
            }}>
                {/* Path selector above input */}


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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />

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
                        marginHorizontal: 8,
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
        </KeyboardAvoidingView>
    )
}
