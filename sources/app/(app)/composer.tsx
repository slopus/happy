import * as React from 'react';
import { 
    View, 
    Text,
    Pressable, 
    Platform,
    KeyboardAvoidingView
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { t } from '@/text';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { Modal as AlertModal } from '@/modal';
import { machineSpawnNewSession } from '@/sync/ops';
import { MultiTextInput, MultiTextInputHandle } from '@/components/MultiTextInput';
import { useRouter, useLocalSearchParams, useNavigation, Stack, useFocusEffect } from 'expo-router';
import { sync } from '@/sync/sync';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { navigateToSession } from '@/utils/navigation';
import { resolveAbsolutePath } from '@/utils/pathUtils';


// Simple temporary state for passing selections back from picker screens
let pendingMachineId: string | null = null;
let pendingPath: string | null = null;

export const composerSelection = {
    setPendingMachine: (machineId: string) => {
        pendingMachineId = machineId;
    },
    setPendingPath: (path: string) => {
        pendingPath = path;
    },
    consumePendingMachine: () => {
        const value = pendingMachineId;
        pendingMachineId = null;
        return value;
    },
    consumePendingPath: () => {
        const value = pendingPath;
        pendingPath = null;
        return value;
    }
};

const PERMISSION_MODES = [
    { id: 'default' as const, label: 'Default', icon: 'shield-checkmark-outline' as const },
    { id: 'acceptEdits' as const, label: 'Accept Edits', icon: 'create-outline' as const },
    { id: 'bypassPermissions' as const, label: 'Bypass', icon: 'flash-outline' as const },
    { id: 'plan' as const, label: 'Plan', icon: 'map-outline' as const },
    { id: 'read-only' as const, label: 'Read Only', icon: 'eye-outline' as const },
    { id: 'safe-yolo' as const, label: 'Safe YOLO', icon: 'rocket-outline' as const },
    { id: 'yolo' as const, label: 'YOLO', icon: 'warning-outline' as const },
];

type PermissionMode = typeof PERMISSION_MODES[number]['id'];

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    contentContainer: {
        flex: 1,
    },
    placeholderContainer: {
        flex: 1,
    },
    inputContainer: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 20,
        paddingTop: 12,
        paddingHorizontal: 12,
        paddingBottom: 8,
        marginHorizontal: 12,
        marginBottom: 12,
    },
    inputWrapper: {
        minHeight: 60,
        maxHeight: 300,
    },
    bottomRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 8,
        gap: 4,
    },
    iconButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHighest,
        gap: 4,
    },
    iconButtonText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    iconButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    iconButtonOffline: {
        opacity: 0.5,
    },
    spacer: {
        flex: 1,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
}));

export default function ComposerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ machineId?: string; selectedPath?: string }>();
    const machines = useAllMachines();
    const inputRef = useRef<MultiTextInputHandle>(null);
    
    const [message, setMessage] = useState('');
    const [selectedMachine, setSelectedMachine] = useState(() => {
        // Use machineId from params if available
        if (params.machineId) {
            const machine = machines.find(m => m.id === params.machineId);
            if (machine) return machine;
        }
        // Otherwise use first online machine or first machine
        return machines.find(m => isMachineOnline(m)) || machines[0];
    });
    const [selectedPath, setSelectedPath] = useState(params.selectedPath || '~');
    const [selectedPermission, setSelectedPermission] = useState<PermissionMode>('default');
    const [isCreating, setIsCreating] = useState(false);
    
    // Set navigation title and subtitle
    useLayoutEffect(() => {
        // Only show subtitle if path is set and not the default
        const shouldShowPath = selectedPath && selectedPath !== '~';
        const displayPath = shouldShowPath 
            ? formatPathRelativeToHome(selectedPath, selectedMachine?.metadata?.homeDir)
            : undefined;
        
        navigation.setOptions({
            headerTitle: t('navigation.newTask') || 'New Task',
            headerSubtitle: displayPath,
        });
    }, [navigation, selectedPath, selectedMachine]);
    
    // Handle selections when returning from picker screens
    useFocusEffect(
        useCallback(() => {
            // Check for pending path selection first (from path picker)
            const pendingPath = composerSelection.consumePendingPath();
            if (pendingPath) {
                setSelectedPath(pendingPath);
                // Path picker also sends back machine ID to preserve it
                const pendingMachineId = composerSelection.consumePendingMachine();
                if (pendingMachineId) {
                    const machine = machines.find(m => m.id === pendingMachineId);
                    if (machine) {
                        setSelectedMachine(machine);
                    }
                }
                return;
            }
            
            // Check for pending machine selection (from machine picker)
            const pendingMachineId = composerSelection.consumePendingMachine();
            if (pendingMachineId) {
                const machine = machines.find(m => m.id === pendingMachineId);
                if (machine) {
                    setSelectedMachine(machine);
                    // Reset path when switching machine from machine picker
                    setSelectedPath('~');
                }
            }
        }, [machines])
    );
    
    // Handle initial params from navigation
    useEffect(() => {
        if (params.machineId && !selectedMachine) {
            const machine = machines.find(m => m.id === params.machineId);
            if (machine) {
                setSelectedMachine(machine);
            }
        }
        if (params.selectedPath && selectedPath === '~') {
            setSelectedPath(params.selectedPath);
        }
    }, [params.machineId, params.selectedPath, machines]);
    
    // Remove auto-focus to prevent animation issues
    // User can tap to focus when ready
    
    const handleCreate = useCallback(async () => {
        if (!message.trim() || !selectedMachine || isCreating) return;
        
        setIsCreating(true);
        try {
            // Resolve ~ to absolute path before sending to RPC
            const absolutePath = resolveAbsolutePath(selectedPath, selectedMachine.metadata?.homeDir);
            const result = await machineSpawnNewSession({
                machineId: selectedMachine.id,
                directory: absolutePath,
                approvedNewDirectoryCreation: false
            });
            
            if (result.type === 'success') {
                // Replace current screen with the new session
                navigateToSession(result.sessionId);
                
                // Send the message after a short delay
                setTimeout(() => {
                    sync.sendMessage(result.sessionId, message.trim());
                }, 100);
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                const approved = await AlertModal.confirm(
                    t('modals.createDirectory.title'),
                    `${t('modals.createDirectory.message')}: ${result.directory}`
                );
                
                if (approved) {
                    // Resolve ~ to absolute path before sending to RPC
                    const absolutePath = resolveAbsolutePath(selectedPath, selectedMachine.metadata?.homeDir);
                    const retryResult = await machineSpawnNewSession({
                        machineId: selectedMachine.id,
                        directory: absolutePath,
                        approvedNewDirectoryCreation: true
                    });
                    
                    if (retryResult.type === 'success') {
                        navigateToSession(retryResult.sessionId);
                        setTimeout(() => {
                            sync.sendMessage(retryResult.sessionId, message.trim());
                        }, 100);
                    }
                }
            } else if (result.type === 'error') {
                AlertModal.alert(
                    'Error',
                    result.errorMessage
                );
            }
        } catch (error) {
            AlertModal.alert(
                'Error',
                error instanceof Error ? error.message : 'An unexpected error occurred'
            );
        } finally {
            setIsCreating(false);
        }
    }, [message, selectedMachine, selectedPath, router]);
    
    const handleSelectMachine = useCallback(() => {
        router.push({
            pathname: '/composer/machine-picker',
            params: { 
                selectedId: selectedMachine?.id
            }
        });
    }, [router, selectedMachine]);
    
    const handleSelectPath = useCallback(() => {
        if (!selectedMachine) {
            AlertModal.alert('Select Machine First', 'Please select a machine before choosing a path');
            return;
        }
        router.push({
            pathname: '/composer/path-picker',
            params: { 
                machineId: selectedMachine.id,
                selectedPath: selectedPath
            }
        });
    }, [router, selectedMachine, selectedPath]);
    
    const handleSelectPermission = useCallback(() => {
        // Cycle through permission modes for now
        const currentIndex = PERMISSION_MODES.findIndex(m => m.id === selectedPermission);
        const nextIndex = (currentIndex + 1) % PERMISSION_MODES.length;
        setSelectedPermission(PERMISSION_MODES[nextIndex].id);
    }, [selectedPermission]);
    
    const canCreate = message.trim().length > 0 && selectedMachine && !isCreating;
    const isMachineOnlineStatus = selectedMachine ? isMachineOnline(selectedMachine) : false;
    
    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: t('navigation.newTask') || 'New Task',
                }}
            />
            <View style={styles.container}>
                <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
                >
                    <View style={styles.contentContainer}>
                        {/* Spacer - takes up the rest of the screen */}
                        <View style={styles.placeholderContainer} />
                        
                        {/* Input at bottom like session screen */}
                        <View style={styles.inputContainer}>
                            {/* Input Area */}
                            <View style={styles.inputWrapper}>
                                <MultiTextInput
                                    ref={inputRef}
                                    placeholder={t('composer.placeholder') || 'Describe a task...'}
                                    value={message}
                                    onChangeText={setMessage}
                                    maxHeight={300}
                                />
                            </View>
                            
                            {/* Bottom Row with Icon Pills and Send Button */}
                            <View style={styles.bottomRow}>
                                {/* Machine Selector */}
                                <Pressable 
                                    style={({ pressed }) => [
                                        styles.iconButton,
                                        pressed && styles.iconButtonPressed,
                                        !isMachineOnlineStatus && styles.iconButtonOffline
                                    ]}
                                    onPress={handleSelectMachine}
                                >
                                    <Ionicons 
                                        name="desktop" 
                                        size={14} 
                                        color={isMachineOnlineStatus ? theme.colors.text : theme.colors.textSecondary}
                                    />
                                    {selectedMachine && (
                                        <Text style={styles.iconButtonText} numberOfLines={1}>
                                            {selectedMachine.metadata?.displayName || selectedMachine.metadata?.host || 'Machine'}
                                        </Text>
                                    )}
                                </Pressable>
                                
                                {/* Path Selector */}
                                <Pressable 
                                    style={({ pressed }) => [
                                        styles.iconButton,
                                        pressed && styles.iconButtonPressed
                                    ]}
                                    onPress={handleSelectPath}
                                >
                                    <Ionicons 
                                        name="folder" 
                                        size={14} 
                                        color={theme.colors.text}
                                    />
                                    <Text style={styles.iconButtonText} numberOfLines={1}>
                                        {selectedPath === '~' ? 'Set' : formatPathRelativeToHome(selectedPath, selectedMachine?.metadata?.homeDir)}
                                    </Text>
                                </Pressable>
                                
                                {/* Permission Mode Selector */}
                                <Pressable 
                                    style={({ pressed }) => [
                                        styles.iconButton,
                                        pressed && styles.iconButtonPressed
                                    ]}
                                    onPress={handleSelectPermission}
                                >
                                    <Ionicons 
                                        name={PERMISSION_MODES.find(m => m.id === selectedPermission)?.icon || 'shield-checkmark'} 
                                        size={14} 
                                        color={theme.colors.text}
                                    />
                                </Pressable>
                                
                                {/* Spacer */}
                                <View style={styles.spacer} />
                                
                                {/* Send Button */}
                                <Pressable 
                                    style={[
                                        styles.sendButton,
                                        canCreate ? styles.sendButtonActive : styles.sendButtonInactive
                                    ]}
                                    onPress={handleCreate} 
                                    disabled={!canCreate}
                                >
                                    <Ionicons 
                                        name="arrow-up" 
                                        size={16} 
                                        color={theme.colors.button.primary.tint}
                                    />
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </View>
        </>
    );
}