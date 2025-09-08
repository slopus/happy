import * as React from 'react';
import { 
    View, 
    Text, 
    Pressable, 
    Platform, 
    ScrollView,
    KeyboardAvoidingView
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback, useRef, useEffect } from 'react';
import { t } from '@/text';
import { useAllMachines, storage } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { Modal as AlertModal } from '@/modal';
import { machineSpawnNewSession } from '@/sync/ops';
import { MultiTextInput, MultiTextInputHandle } from '@/components/MultiTextInput';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { sync } from '@/sync/sync';


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

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.colors.divider,
    },
    headerButton: {
        fontSize: 17,
        ...Typography.default(),
    },
    headerButtonCancel: {
        color: theme.colors.textSecondary,
    },
    headerButtonCreate: {
        color: theme.colors.textLink,
    },
    headerButtonDisabled: {
        opacity: 0.3,
    },
    headerTitle: {
        fontSize: 17,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    contentContainer: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
    },
    inputWrapper: {
        flex: 1,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    bottomContainer: {
        backgroundColor: theme.colors.surface,
        borderTopWidth: 0.5,
        borderTopColor: theme.colors.divider,
    },
    pillsScroll: {
        flexGrow: 0,
    },
    pillsContainer: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 8,
    },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 16,
        gap: 6,
    },
    pillPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    pillIcon: {
        marginRight: 2,
    },
    pillText: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    pillValue: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    pillDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.status.disconnected,
    },
}));

export default function ComposerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{ machineId?: string; selectedPath?: string }>();
    const safeArea = useSafeAreaInsets();
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
    
    // Update state when params change (when returning from pickers)
    useEffect(() => {
        if (params.machineId) {
            const machine = machines.find(m => m.id === params.machineId);
            if (machine && selectedMachine?.id !== machine.id) {
                setSelectedMachine(machine);
                // Reset path to default when switching to a different machine
                setSelectedPath('~');
            }
        }
        if (params.selectedPath) {
            setSelectedPath(params.selectedPath);
        }
    }, [params.machineId, params.selectedPath, machines]);
    
    // Focus input on mount
    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    
    const handleCancel = useCallback(() => {
        router.back();
    }, [router]);
    
    const handleCreate = useCallback(async () => {
        if (!message.trim() || !selectedMachine || isCreating) return;
        
        setIsCreating(true);
        try {
            const result = await machineSpawnNewSession({
                machineId: selectedMachine.id,
                directory: selectedPath === '~' ? '' : selectedPath,
                approvedNewDirectoryCreation: false
            });
            
            if (result.type === 'success') {
                // Navigate to the new session and send message
                router.back(); // Close composer
                router.push(`/session/${result.sessionId}`);
                
                // Send the message after a short delay
                setTimeout(() => {
                    sync.sendMessage(result.sessionId, message.trim());
                }, 100);
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                const approved = await AlertModal.confirm(
                    t('modals.createDirectory.title'),
                    t('modals.createDirectory.message', { directory: result.directory })
                );
                
                if (approved) {
                    const retryResult = await machineSpawnNewSession({
                        machineId: selectedMachine.id,
                        directory: selectedPath === '~' ? '' : selectedPath,
                        approvedNewDirectoryCreation: true
                    });
                    
                    if (retryResult.type === 'success') {
                        router.back();
                        router.push(`/session/${retryResult.sessionId}`);
                        setTimeout(() => {
                            sync.sendMessage(retryResult.sessionId, message.trim());
                        }, 100);
                    }
                }
            } else if (result.type === 'error') {
                await AlertModal.alert(
                    'Error',
                    result.errorMessage
                );
            }
        } catch (error) {
            await AlertModal.alert(
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
            params: { selectedId: selectedMachine?.id }
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
        AlertModal.alert('Coming Soon', 'Permission selection will be implemented');
    }, []);
    
    const canCreate = message.trim().length > 0 && selectedMachine && !isCreating;
    
    return (
        <View style={styles.container}>
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={0}
            >
                <View style={[styles.container, { paddingTop: safeArea.top }]}>
                        
                        {/* Header */}
                        <View style={styles.header}>
                            <Pressable onPress={handleCancel} disabled={isCreating}>
                                <Text style={[styles.headerButton, styles.headerButtonCancel]}>
                                    {t('common.cancel')}
                                </Text>
                            </Pressable>
                            
                            <Text style={styles.headerTitle}>New Session</Text>
                            
                            <Pressable onPress={handleCreate} disabled={!canCreate}>
                                <Text style={[
                                    styles.headerButton, 
                                    styles.headerButtonCreate,
                                    !canCreate && styles.headerButtonDisabled
                                ]}>
                                    {t('common.create')}
                                </Text>
                            </Pressable>
                        </View>
                        
                        {/* Input Area */}
                        <View style={styles.contentContainer}>
                            <View style={styles.inputWrapper}>
                                <MultiTextInput
                                    ref={inputRef}
                                    placeholder={t('session.inputPlaceholder')}
                                    value={message}
                                    onChangeText={setMessage}
                                    maxHeight={400}
                                />
                            </View>
                        </View>
                        
                        {/* Bottom Pills - Above keyboard */}
                        <View style={[styles.bottomContainer, { paddingBottom: safeArea.bottom || 8 }]}>
                            <ScrollView 
                                horizontal 
                                showsHorizontalScrollIndicator={false}
                                style={styles.pillsScroll}
                                contentContainerStyle={styles.pillsContainer}
                                keyboardShouldPersistTaps="handled"
                            >
                                {/* Path Pill */}
                                <Pressable 
                                    style={({ pressed }) => [
                                        styles.pill,
                                        pressed && styles.pillPressed
                                    ]}
                                    onPress={handleSelectPath}
                                >
                                    <Ionicons 
                                        name="folder-outline" 
                                        size={16} 
                                        color={theme.colors.textSecondary}
                                        style={styles.pillIcon}
                                    />
                                    <Text style={styles.pillText}>{selectedPath}</Text>
                                </Pressable>
                                
                                {/* Machine Pill */}
                                <Pressable 
                                    style={({ pressed }) => [
                                        styles.pill,
                                        pressed && styles.pillPressed
                                    ]}
                                    onPress={handleSelectMachine}
                                >
                                    <Ionicons 
                                        name="desktop-outline" 
                                        size={16} 
                                        color={theme.colors.textSecondary}
                                        style={styles.pillIcon}
                                    />
                                    {selectedMachine && isMachineOnline(selectedMachine) ? (
                                        <Text style={styles.pillText}>
                                            {selectedMachine.metadata?.displayName || 
                                             selectedMachine.metadata?.host || 
                                             selectedMachine.id}
                                        </Text>
                                    ) : (
                                        <>
                                            <Text style={styles.pillValue}>
                                                {selectedMachine?.metadata?.displayName || 
                                                 selectedMachine?.metadata?.host || 
                                                 'No machine'}
                                            </Text>
                                            <View style={styles.pillDot} />
                                        </>
                                    )}
                                </Pressable>
                                
                                {/* Permission Pill */}
                                <Pressable 
                                    style={({ pressed }) => [
                                        styles.pill,
                                        pressed && styles.pillPressed
                                    ]}
                                    onPress={handleSelectPermission}
                                >
                                    <Ionicons 
                                        name={PERMISSION_MODES.find(m => m.id === selectedPermission)?.icon || 'shield-checkmark-outline'}
                                        size={16} 
                                        color={theme.colors.textSecondary}
                                        style={styles.pillIcon}
                                    />
                                    <Text style={styles.pillText}>
                                        {PERMISSION_MODES.find(m => m.id === selectedPermission)?.label || 'Default'}
                                    </Text>
                                </Pressable>
                            </ScrollView>
                        </View>
                </View>
            </KeyboardAvoidingView>
        </View>
    );
}