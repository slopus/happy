import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { PermissionModeSelector, PermissionMode, ModelMode } from '@/components/PermissionModeSelector';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMachines, useSessions, useSetting } from '@/sync/storage';
import { useRouter } from 'expo-router';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stepIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    stepDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginHorizontal: 4,
    },
    stepDotActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    stepDotInactive: {
        backgroundColor: theme.colors.divider,
    },
    stepContent: {
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 24,
        paddingBottom: 0, // No bottom padding since footer is separate
    },
    stepTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    stepDescription: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 24,
        ...Typography.default(),
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface, // Ensure footer has solid background
    },
    button: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 8,
        minWidth: 100,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    buttonTextPrimary: {
        color: '#FFFFFF',
    },
    buttonTextSecondary: {
        color: theme.colors.text,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        ...Typography.default(),
    },
    agentOption: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderRadius: 12,
        borderWidth: 2,
        marginBottom: 12,
    },
    agentOptionSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.input.background,
    },
    agentOptionUnselected: {
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
    },
    agentIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
    },
    agentInfo: {
        flex: 1,
    },
    agentName: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginTop: 4,
        ...Typography.default(),
    },
}));

type WizardStep = 'sessionType' | 'agent' | 'options' | 'machine' | 'path' | 'prompt';

interface NewSessionWizardProps {
    onComplete: (config: {
        sessionType: 'simple' | 'worktree';
        agentType: 'claude' | 'codex';
        permissionMode: PermissionMode;
        modelMode: ModelMode;
        machineId: string;
        path: string;
        prompt: string;
    }) => void;
    onCancel: () => void;
    initialPrompt?: string;
}

export function NewSessionWizard({ onComplete, onCancel, initialPrompt = '' }: NewSessionWizardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const machines = useAllMachines();
    const sessions = useSessions();
    const experimentsEnabled = useSetting('experiments');
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const lastUsedModelMode = useSetting('lastUsedModelMode');

    // Wizard state
    const [currentStep, setCurrentStep] = useState<WizardStep>('sessionType');
    const [sessionType, setSessionType] = useState<'simple' | 'worktree'>('simple');
    const [agentType, setAgentType] = useState<'claude' | 'codex'>(() => {
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex') {
            return lastUsedAgent;
        }
        return 'claude';
    });
    const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
    const [modelMode, setModelMode] = useState<ModelMode>('default');
    const [selectedMachineId, setSelectedMachineId] = useState<string>(() => {
        if (machines.length > 0) {
            // Check if we have a recently used machine that's currently available
            if (recentMachinePaths.length > 0) {
                for (const recent of recentMachinePaths) {
                    if (machines.find(m => m.id === recent.machineId)) {
                        return recent.machineId;
                    }
                }
            }
            return machines[0].id;
        }
        return '';
    });
    const [selectedPath, setSelectedPath] = useState<string>(() => {
        if (machines.length > 0 && selectedMachineId) {
            const machine = machines.find(m => m.id === selectedMachineId);
            return machine?.metadata?.homeDir || '/home';
        }
        return '/home';
    });
    const [prompt, setPrompt] = useState<string>(initialPrompt);
    const [customPath, setCustomPath] = useState<string>('');
    const [showCustomPathInput, setShowCustomPathInput] = useState<boolean>(false);

    const steps: WizardStep[] = experimentsEnabled
        ? ['sessionType', 'agent', 'options', 'machine', 'path', 'prompt']
        : ['agent', 'options', 'machine', 'path', 'prompt'];

    // Get recent paths for the selected machine
    const recentPaths = useMemo(() => {
        if (!selectedMachineId) return [];

        const paths: string[] = [];
        const pathSet = new Set<string>();

        // First, add paths from recentMachinePaths (these are the most recent)
        recentMachinePaths.forEach(entry => {
            if (entry.machineId === selectedMachineId && !pathSet.has(entry.path)) {
                paths.push(entry.path);
                pathSet.add(entry.path);
            }
        });

        // Then add paths from sessions if we need more
        if (sessions) {
            const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

            sessions.forEach(item => {
                if (typeof item === 'string') return; // Skip section headers

                const session = item as any;
                if (session.metadata?.machineId === selectedMachineId && session.metadata?.path) {
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

            // Sort session paths by most recent first and add them
            pathsWithTimestamps
                .sort((a, b) => b.timestamp - a.timestamp)
                .forEach(item => paths.push(item.path));
        }

        return paths;
    }, [sessions, selectedMachineId, recentMachinePaths]);

    const currentStepIndex = steps.indexOf(currentStep);
    const isFirstStep = currentStepIndex === 0;
    const isLastStep = currentStepIndex === steps.length - 1;

    const handleNext = () => {
        if (isLastStep) {
            onComplete({
                sessionType,
                agentType,
                permissionMode,
                modelMode,
                machineId: selectedMachineId,
                path: showCustomPathInput && customPath.trim() ? customPath.trim() : selectedPath,
                prompt,
            });
        } else {
            setCurrentStep(steps[currentStepIndex + 1]);
        }
    };

    const handleBack = () => {
        if (isFirstStep) {
            onCancel();
        } else {
            setCurrentStep(steps[currentStepIndex - 1]);
        }
    };

    const canProceed = useMemo(() => {
        switch (currentStep) {
            case 'sessionType':
                return true; // Always valid
            case 'agent':
                return true; // Always valid
            case 'options':
                return true; // Always valid
            case 'machine':
                return selectedMachineId.length > 0;
            case 'path':
                return (selectedPath.trim().length > 0) || (showCustomPathInput && customPath.trim().length > 0);
            case 'prompt':
                return prompt.trim().length > 0;
            default:
                return false;
        }
    }, [currentStep, selectedMachineId, selectedPath, prompt, showCustomPathInput, customPath]);

    const renderStepContent = () => {
        switch (currentStep) {
            case 'sessionType':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Choose Session Type</Text>
                        <Text style={styles.stepDescription}>
                            Select how you want to work with your code
                        </Text>
                        <SessionTypeSelector
                            value={sessionType}
                            onChange={setSessionType}
                        />
                    </View>
                );

            case 'agent':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Choose AI Agent</Text>
                        <Text style={styles.stepDescription}>
                            Select which AI assistant you want to use
                        </Text>

                        <Pressable
                            style={[
                                styles.agentOption,
                                agentType === 'claude' ? styles.agentOptionSelected : styles.agentOptionUnselected
                            ]}
                            onPress={() => setAgentType('claude')}
                        >
                            <View style={styles.agentIcon}>
                                <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>C</Text>
                            </View>
                            <View style={styles.agentInfo}>
                                <Text style={styles.agentName}>Claude</Text>
                                <Text style={styles.agentDescription}>
                                    Anthropic's AI assistant, great for coding and analysis
                                </Text>
                            </View>
                            {agentType === 'claude' && (
                                <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
                            )}
                        </Pressable>

                        <Pressable
                            style={[
                                styles.agentOption,
                                agentType === 'codex' ? styles.agentOptionSelected : styles.agentOptionUnselected
                            ]}
                            onPress={() => setAgentType('codex')}
                        >
                            <View style={styles.agentIcon}>
                                <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>X</Text>
                            </View>
                            <View style={styles.agentInfo}>
                                <Text style={styles.agentName}>Codex</Text>
                                <Text style={styles.agentDescription}>
                                    OpenAI's specialized coding assistant
                                </Text>
                            </View>
                            {agentType === 'codex' && (
                                <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
                            )}
                        </Pressable>
                    </View>
                );

            case 'options':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Agent Options</Text>
                        <Text style={styles.stepDescription}>
                            Configure how the AI agent should behave
                        </Text>
                        <ItemGroup title="Permission Mode">
                            {([
                                { value: 'default', label: 'Default', description: 'Ask for permissions', icon: 'shield-outline' },
                                { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve edits', icon: 'checkmark-outline' },
                                { value: 'plan', label: 'Plan', description: 'Plan before executing', icon: 'list-outline' },
                                { value: 'bypassPermissions', label: 'Bypass Permissions', description: 'Skip all permissions', icon: 'flash-outline' },
                            ] as const).map((option, index, array) => (
                                <Item
                                    key={option.value}
                                    title={option.label}
                                    subtitle={option.description}
                                    leftElement={
                                        <Ionicons
                                            name={option.icon}
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={permissionMode === option.value ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => setPermissionMode(option.value as PermissionMode)}
                                    showChevron={false}
                                    selected={permissionMode === option.value}
                                    showDivider={index < array.length - 1}
                                />
                            ))}
                        </ItemGroup>

                        <ItemGroup title="Model Mode">
                            {(agentType === 'claude' ? [
                                { value: 'default', label: 'Default', description: 'Balanced performance', icon: 'cube-outline' },
                                { value: 'adaptiveUsage', label: 'Adaptive Usage', description: 'Automatically choose model', icon: 'analytics-outline' },
                                { value: 'sonnet', label: 'Sonnet', description: 'Fast and efficient', icon: 'speedometer-outline' },
                                { value: 'opus', label: 'Opus', description: 'Most capable model', icon: 'diamond-outline' },
                            ] as const : [
                                { value: 'gpt-5-codex-high', label: 'GPT-5 Codex High', description: 'Best for complex coding', icon: 'diamond-outline' },
                                { value: 'gpt-5-codex-medium', label: 'GPT-5 Codex Medium', description: 'Balanced coding assistance', icon: 'cube-outline' },
                                { value: 'gpt-5-codex-low', label: 'GPT-5 Codex Low', description: 'Fast coding help', icon: 'speedometer-outline' },
                            ] as const).map((option, index, array) => (
                                <Item
                                    key={option.value}
                                    title={option.label}
                                    subtitle={option.description}
                                    leftElement={
                                        <Ionicons
                                            name={option.icon}
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={modelMode === option.value ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => setModelMode(option.value as ModelMode)}
                                    showChevron={false}
                                    selected={modelMode === option.value}
                                    showDivider={index < array.length - 1}
                                />
                            ))}
                        </ItemGroup>
                    </View>
                );

            case 'machine':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Select Machine</Text>
                        <Text style={styles.stepDescription}>
                            Choose which machine to run your session on
                        </Text>

                        <ItemGroup title="Available Machines">
                            {machines.map((machine, index) => (
                                <Item
                                    key={machine.id}
                                    title={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                                    subtitle={machine.metadata?.host || ''}
                                    leftElement={
                                        <Ionicons
                                            name="laptop-outline"
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={selectedMachineId === machine.id ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => {
                                        setSelectedMachineId(machine.id);
                                        // Update path when machine changes
                                        const homeDir = machine.metadata?.homeDir || '/home';
                                        setSelectedPath(homeDir);
                                    }}
                                    showChevron={false}
                                    selected={selectedMachineId === machine.id}
                                    showDivider={index < machines.length - 1}
                                />
                            ))}
                        </ItemGroup>
                    </View>
                );

            case 'path':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Working Directory</Text>
                        <Text style={styles.stepDescription}>
                            Choose the directory to work in
                        </Text>

                        {/* Recent Paths */}
                        {recentPaths.length > 0 && (
                            <ItemGroup title="Recent Paths">
                                {recentPaths.map((path, index) => (
                                    <Item
                                        key={path}
                                        title={path}
                                        subtitle="Recently used"
                                        leftElement={
                                            <Ionicons
                                                name="time-outline"
                                                size={24}
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={selectedPath === path && !showCustomPathInput ? (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.button.primary.background}
                                            />
                                        ) : null}
                                        onPress={() => {
                                            setSelectedPath(path);
                                            setShowCustomPathInput(false);
                                        }}
                                        showChevron={false}
                                        selected={selectedPath === path && !showCustomPathInput}
                                        showDivider={index < recentPaths.length - 1}
                                    />
                                ))}
                            </ItemGroup>
                        )}

                        {/* Common Directories */}
                        <ItemGroup title="Common Directories">
                            {(() => {
                                const machine = machines.find(m => m.id === selectedMachineId);
                                const homeDir = machine?.metadata?.homeDir || '/home';
                                const pathOptions = [
                                    { value: homeDir, label: homeDir, description: 'Home directory' },
                                    { value: `${homeDir}/projects`, label: `${homeDir}/projects`, description: 'Projects folder' },
                                    { value: `${homeDir}/Documents`, label: `${homeDir}/Documents`, description: 'Documents folder' },
                                    { value: `${homeDir}/Desktop`, label: `${homeDir}/Desktop`, description: 'Desktop folder' },
                                ];
                                return pathOptions.map((option, index) => (
                                    <Item
                                        key={option.value}
                                        title={option.label}
                                        subtitle={option.description}
                                        leftElement={
                                            <Ionicons
                                                name="folder-outline"
                                                size={24}
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={selectedPath === option.value && !showCustomPathInput ? (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.button.primary.background}
                                            />
                                        ) : null}
                                        onPress={() => {
                                            setSelectedPath(option.value);
                                            setShowCustomPathInput(false);
                                        }}
                                        showChevron={false}
                                        selected={selectedPath === option.value && !showCustomPathInput}
                                        showDivider={index < pathOptions.length - 1}
                                    />
                                ));
                            })()}
                        </ItemGroup>

                        {/* Custom Path Option */}
                        <ItemGroup title="Custom Directory">
                            <Item
                                title="Enter custom path"
                                subtitle={showCustomPathInput && customPath ? customPath : "Specify a custom directory path"}
                                leftElement={
                                    <Ionicons
                                        name="create-outline"
                                        size={24}
                                        color={theme.colors.textSecondary}
                                    />
                                }
                                rightElement={showCustomPathInput ? (
                                    <Ionicons
                                        name="checkmark-circle"
                                        size={20}
                                        color={theme.colors.button.primary.background}
                                    />
                                ) : null}
                                onPress={() => setShowCustomPathInput(true)}
                                showChevron={false}
                                selected={showCustomPathInput}
                                showDivider={false}
                            />
                            {showCustomPathInput && (
                                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                                    <TextInput
                                        style={styles.textInput}
                                        placeholder="Enter directory path (e.g. /home/user/my-project)"
                                        placeholderTextColor={theme.colors.textSecondary}
                                        value={customPath}
                                        onChangeText={setCustomPath}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        returnKeyType="done"
                                    />
                                </View>
                            )}
                        </ItemGroup>
                    </View>
                );

            case 'prompt':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Initial Message</Text>
                        <Text style={styles.stepDescription}>
                            Write your first message to the AI agent
                        </Text>

                        <TextInput
                            style={[styles.textInput, { height: 120, textAlignVertical: 'top' }]}
                            placeholder={t('session.inputPlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={prompt}
                            onChangeText={setPrompt}
                            multiline={true}
                            autoCapitalize="sentences"
                            autoCorrect={true}
                            returnKeyType="default"
                        />
                    </View>
                );

            default:
                return null;
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>New Session</Text>
                <Pressable onPress={onCancel}>
                    <Ionicons name="close" size={24} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.stepIndicator}>
                {steps.map((step, index) => (
                    <View
                        key={step}
                        style={[
                            styles.stepDot,
                            index <= currentStepIndex ? styles.stepDotActive : styles.stepDotInactive
                        ]}
                    />
                ))}
            </View>

            <ScrollView
                style={styles.stepContent}
                contentContainerStyle={{ paddingBottom: 24 }}
                showsVerticalScrollIndicator={true}
            >
                {renderStepContent()}
            </ScrollView>

            <View style={styles.footer}>
                <Pressable
                    style={[styles.button, styles.buttonSecondary]}
                    onPress={handleBack}
                >
                    <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                        {isFirstStep ? 'Cancel' : 'Back'}
                    </Text>
                </Pressable>

                <Pressable
                    style={[
                        styles.button,
                        styles.buttonPrimary,
                        !canProceed && { opacity: 0.5 }
                    ]}
                    onPress={handleNext}
                    disabled={!canProceed}
                >
                    <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                        {isLastStep ? 'Create Session' : 'Next'}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}