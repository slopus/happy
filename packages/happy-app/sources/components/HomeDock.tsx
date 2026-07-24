import * as React from 'react';
import { ActivityIndicator, Keyboard, Modal as RNModal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { MobileGlassSurface } from './MobileGlass';
import { BubblePressable } from './BubblePressable';
import { NativeOptionsPicker } from './NativeOptionsPicker';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';
import { t } from '@/text';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useAllMachines, useSessions, useSetting } from '@/sync/storage';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { formatLastSeen, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { listWorktrees } from '@/utils/worktree';
import type { Machine, Session } from '@/sync/storageTypes';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    getSupportsWorktree,
    type ModeOption,
} from './modelModeOptions';
import type { NewSessionAgentType } from '@/sync/persistence';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';

export const MOBILE_HOME_DOCK_CONTENT_INSET = 108;

type EnvironmentSetting = 'machine' | 'project' | 'worktree';
type AgentSetting = 'agent' | 'model' | 'permission' | 'effort';

const CUSTOM_PROJECT_PATH_KEY = '__custom_project_path__';

const AGENTS: Array<{ key: NewSessionAgentType; name: string }> = [
    { key: 'claude', name: 'Claude Code' },
    { key: 'codex', name: 'Codex' },
    { key: 'openclaw', name: 'OpenClaw' },
    { key: 'gemini', name: 'Gemini' },
    { key: 'agy', name: 'Agy' },
];

const styles = StyleSheet.create((theme) => ({
    keyboardFollower: {
        width: '100%',
    },
    safeArea: {
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    composerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: 56,
        alignSelf: 'center',
        borderRadius: 28,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    composerContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 7,
        gap: 4,
    },
    sideButton: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sideButtonPressed: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    input: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        paddingHorizontal: 4,
        paddingVertical: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    inputEntry: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    inputEntryText: {
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    inputEntryPlaceholder: {
        color: theme.colors.textSecondary,
    },
    focusedComposerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: 126,
        alignSelf: 'center',
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    focusedComposerSurfaceWithAttachments: {
        height: 206,
    },
    focusedComposerAnimationShell: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: 30,
        overflow: 'hidden',
    },
    focusedComposerAnchored: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusedComposerContent: {
        flex: 1,
        paddingHorizontal: 10,
        paddingTop: 10,
        paddingBottom: 8,
    },
    focusedInput: {
        flex: 1,
        minHeight: 58,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
        color: theme.colors.text,
        fontSize: 18,
        textAlignVertical: 'top',
        ...Typography.default(),
    },
    focusedInputReveal: {
        flex: 1,
        minHeight: 0,
    },
    focusedComposerActions: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    focusedModeButton: {
        width: '100%',
        minWidth: 0,
        height: 40,
        paddingHorizontal: 8,
        borderRadius: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingRight: 0,
        gap: 7,
    },
    nativeGearMenu: {
        width: 42,
        height: 42,
    },
    nativeModeMenu: {
        flex: 1,
        minWidth: 0,
        height: 40,
    },
    nativeEffortMenu: {
        width: 64,
        flexShrink: 0,
        height: 40,
    },
    focusedEffortButton: {
        width: '100%',
        height: 40,
        paddingLeft: 2,
        paddingRight: 0,
        borderRadius: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 4,
    },
    focusedModeText: {
        flexShrink: 1,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    focusedModeSeparator: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        ...Typography.default(),
    },
    sendButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    focusedSendButton: {
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: '#F5F5F5',
    },
    modalRoot: {
        flex: 1,
    },
    modalBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusBackdrop: {
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
    },
    focusBackPosition: {
        position: 'absolute',
        left: 20,
    },
    focusBackSurface: {
        width: 52,
        height: 52,
        borderRadius: 26,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
    },
    focusBackButton: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    focusDock: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusConfig: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 24,
        paddingBottom: 10,
        gap: 8,
    },
    focusConfigGroup: {
        gap: 1,
    },
    focusConfigRevealRow: {
        width: '100%',
    },
    focusInlineSurface: {
        maxHeight: 220,
    },
    focusConfigRow: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 6,
        borderRadius: 12,
    },
    focusConfigIcon: {
        width: 24,
        alignItems: 'center',
    },
    focusConfigValue: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    focusConfigChevron: {
        width: 16,
        alignItems: 'center',
        gap: -5,
    },
    focusComposerArea: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    settingsPosition: {
        position: 'absolute',
        left: 16,
        right: 16,
    },
    settingsStack: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        gap: 10,
    },
    settingsSurface: {
        width: '100%',
        maxHeight: 270,
        borderRadius: 24,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: theme.colors.glass.overlay,
            default: theme.colors.glass.backgroundStrong,
        }),
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    settingsHeader: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingBottom: 4,
    },
    backButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    optionList: {
        flexGrow: 0,
    },
    option: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 14,
    },
    optionPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    optionCopy: {
        flex: 1,
        minWidth: 0,
    },
    optionLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
    optionValue: {
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default(),
    },
    optionDescription: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 2,
        ...Typography.default(),
    },
}));

function resolveOption(options: ModeOption[], preferred: Array<string | null | undefined>): ModeOption | null {
    for (const key of preferred) {
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'Unknown machine';
}

function FocusConfigRevealRow({
    progress,
    index,
    children,
}: {
    progress: SharedValue<number>;
    index: number;
    children: React.ReactNode;
}) {
    const revealStyle = useAnimatedStyle(() => {
        const start = 0.18 + index * 0.09;
        const end = start + 0.28;
        const reveal = interpolate(
            progress.value,
            [start, end],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 10 * (1 - reveal) }],
        };
    }, [index]);

    return (
        <Animated.View style={[styles.focusConfigRevealRow, revealStyle]}>
            {children}
        </Animated.View>
    );
}

export const HomeDock = React.memo(({
    prompt,
    onPromptChange,
    onSubmit,
    isSubmitting,
}: {
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => Promise<boolean>;
    isSubmitting: boolean;
}) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const inputRef = React.useRef<TextInput>(null);
    const focusedInputRef = React.useRef<TextInput>(null);
    const focusAnimationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusPresentation = useSharedValue(0);
    const [isFocused, setIsFocused] = React.useState(false);
    const [focusModeVisible, setFocusModeVisible] = React.useState(false);
    const expImageUpload = useSetting('expImageUpload');
    const { selectedImages, pickImages, removeImage, clearImages } = useImagePicker();
    const agentType = useNewSessionDraft((state) => state.agentType);
    const selectedMachineId = useNewSessionDraft((state) => state.selectedMachineId);
    const selectedPath = useNewSessionDraft((state) => state.selectedPath);
    const sessionType = useNewSessionDraft((state) => state.sessionType);
    const worktreeKey = useNewSessionDraft((state) => state.worktreeKey);
    const permissionMode = useNewSessionDraft((state) => state.permissionMode);
    const modelMode = useNewSessionDraft((state) => state.modelMode);
    const effortLevel = useNewSessionDraft((state) => state.effortLevel);
    const setMachineId = useNewSessionDraft((state) => state.setMachineId);
    const setAgentType = useNewSessionDraft((state) => state.setAgentType);
    const setPath = useNewSessionDraft((state) => state.setPath);
    const setSessionType = useNewSessionDraft((state) => state.setSessionType);
    const setWorktreeKey = useNewSessionDraft((state) => state.setWorktreeKey);
    const setPermissionMode = useNewSessionDraft((state) => state.setPermissionMode);
    const setModelMode = useNewSessionDraft((state) => state.setModelMode);
    const setEffortLevel = useNewSessionDraft((state) => state.setEffortLevel);
    const defaultOverrides = useSetting('agentDefaultOverrides');
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === selectedMachineId) ?? null,
        [machines, selectedMachineId],
    );
    const machineOptions = React.useMemo<ModeOption[]>(() => (
        [...machines]
            .sort((left, right) => Number(isMachineOnline(right)) - Number(isMachineOnline(left)))
            .map((machine) => ({
                key: machine.id,
                name: getMachineName(machine),
                description: isMachineOnline(machine)
                    ? t('status.online')
                    : t('status.lastSeen', { time: formatLastSeen(machine.activeAt, false) }),
            }))
    ), [machines]);
    const currentMachine = resolveOption(machineOptions, [selectedMachineId]);

    React.useEffect(() => {
        if (!selectedMachineId && machineOptions[0]) {
            setMachineId(machineOptions[0].key);
        }
    }, [machineOptions, selectedMachineId, setMachineId]);

    const projectOptions = React.useMemo<ModeOption[]>(() => {
        const paths = new Set<string>();
        paths.add(selectedPath ?? '~');

        if (selectedMachineId && sessions) {
            for (const item of sessions) {
                if (typeof item === 'string') continue;
                const session = item as Session;
                if (session.metadata?.machineId === selectedMachineId && session.metadata.path) {
                    paths.add(session.metadata.path);
                }
            }
        }

        const homeDir = selectedMachine?.metadata?.homeDir;
        return Array.from(paths).map((path) => {
            const name = formatPathRelativeToHome(path, homeDir);
            return {
                key: path,
                name,
                description: name === path ? undefined : path,
            };
        });
    }, [selectedMachine, selectedMachineId, selectedPath, sessions]);
    const currentProject = resolveOption(projectOptions, [selectedPath, '~']);
    const supportsWorktree = getSupportsWorktree(agentType);
    const selectedWorktreeKey = sessionType === 'worktree'
        ? worktreeKey ?? '__new__'
        : '__none__';
    const [existingWorktrees, setExistingWorktrees] = React.useState<ModeOption[]>([]);

    React.useEffect(() => {
        const path = resolveAbsolutePath(selectedPath ?? '~', selectedMachine?.metadata?.homeDir);
        if (!supportsWorktree || !selectedMachineId || !selectedMachine || !isMachineOnline(selectedMachine) || !path) {
            setExistingWorktrees([]);
            return;
        }

        let cancelled = false;
        listWorktrees(selectedMachineId, path).then((worktrees) => {
            if (cancelled) return;
            setExistingWorktrees(worktrees.map((worktree) => ({
                key: worktree.path,
                name: worktree.branch,
                description: worktree.path,
            })));
        });
        return () => {
            cancelled = true;
        };
    }, [selectedMachine, selectedMachineId, selectedPath, supportsWorktree]);

    React.useEffect(() => {
        if (!supportsWorktree && sessionType === 'worktree') {
            setSessionType('simple');
            setWorktreeKey(null);
        }
    }, [sessionType, setSessionType, setWorktreeKey, supportsWorktree]);

    const worktreeOptions = React.useMemo<ModeOption[]>(() => {
        if (!supportsWorktree) {
            return [{
                key: '__none__',
                name: 'No worktree',
                description: `Not supported by ${AGENTS.find((agent) => agent.key === agentType)?.name ?? agentType}`,
            }];
        }
        const options: ModeOption[] = [
            { key: '__none__', name: 'No worktree' },
            { key: '__new__', name: 'Create new worktree' },
            ...existingWorktrees,
        ];
        if (
            worktreeKey
            && !options.some((option) => option.key === worktreeKey)
        ) {
            options.push({ key: worktreeKey, name: worktreeKey });
        }
        return options;
    }, [agentType, existingWorktrees, supportsWorktree, worktreeKey]);
    const currentWorktree = resolveOption(worktreeOptions, [selectedWorktreeKey]);
    const availableAgents = React.useMemo(() => {
        const availability = selectedMachine?.metadata?.cliAvailability;
        if (!availability) return AGENTS;
        return AGENTS.filter((agent) => availability[agent.key]);
    }, [selectedMachine]);
    const defaults = React.useMemo(
        () => resolveAgentDefaultConfig(defaultOverrides, agentType),
        [agentType, defaultOverrides],
    );
    const permissionOptions = React.useMemo(
        () => getHardcodedPermissionModes(agentType, t),
        [agentType],
    );
    const modelOptions = React.useMemo(
        () => getHardcodedModelModes(agentType, t),
        [agentType],
    );
    const currentPermission = resolveOption(permissionOptions, [permissionMode, defaults.permissionMode]);
    const currentModel = resolveOption(modelOptions, [modelMode, defaults.modelMode]);
    const effortOptions = React.useMemo(
        () => getEffortLevelsForModel(agentType, currentModel?.key ?? 'default'),
        [agentType, currentModel?.key],
    );
    const currentEffort = resolveOption(effortOptions, [effortLevel, defaults.effortLevel]);
    const currentAgent = availableAgents.find((agent) => agent.key === agentType) ?? availableAgents[0] ?? AGENTS[0];
    const canSubmit = !isSubmitting && (
        prompt.trim().length > 0 || (expImageUpload && selectedImages.length > 0)
    );
    const focusedComposerHeight = selectedImages.length > 0 ? 206 : 126;
    const keyboardStyle = useAnimatedStyle(() => ({
        // Keyboard height includes the bottom safe area on iOS. The resting
        // dock keeps that inset, then gives it back while the keyboard opens
        // so the composer stays the same 8px above either boundary.
        transform: [{
            translateY: keyboard.height.value + safeArea.bottom * keyboard.progress.value,
        }],
    }), [safeArea.bottom]);
    const focusBackdropStyle = useAnimatedStyle(() => ({
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.35, 1],
            [0, 1, 1],
            Extrapolation.CLAMP,
        ),
    }));
    const focusBackButtonStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.12, 0.52],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [
                { translateY: -8 * (1 - reveal) },
                { scale: 0.94 + 0.06 * reveal },
            ],
        };
    });
    const focusedComposerAnimationStyle = useAnimatedStyle(() => ({
        height: interpolate(
            focusPresentation.value,
            [0, 1],
            [56, focusedComposerHeight],
            Extrapolation.CLAMP,
        ),
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.12, 1],
            [0.72, 1, 1],
            Extrapolation.CLAMP,
        ),
        transform: [{
            scaleX: interpolate(
                focusPresentation.value,
                [0, 1],
                [0.96, 1],
                Extrapolation.CLAMP,
            ),
        }],
    }), [focusedComposerHeight]);
    const focusedInputRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.22, 0.6],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 8 * (1 - reveal) }],
        };
    });
    const focusedActionsRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.46, 0.82],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 7 * (1 - reveal) }],
        };
    });

    React.useEffect(() => {
        if (!focusModeVisible) return;
        const timeout = setTimeout(() => focusedInputRef.current?.focus(), 50);
        return () => clearTimeout(timeout);
    }, [focusModeVisible]);

    React.useEffect(() => () => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
        }
    }, []);

    React.useEffect(() => {
        if (!expImageUpload && selectedImages.length > 0) {
            clearImages();
            useNewSessionDraft.getState().setAttachments([]);
        }
    }, [clearImages, expImageUpload, selectedImages.length]);

    const openFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
        }
        focusPresentation.value = 0;
        setIsFocused(true);
        setFocusModeVisible(true);
        focusAnimationTimerRef.current = setTimeout(() => {
            focusPresentation.value = withTiming(1, {
                duration: 340,
                easing: Easing.out(Easing.cubic),
            });
            focusAnimationTimerRef.current = null;
        }, 16);
    }, [focusPresentation]);

    const finishCloseFocusMode = React.useCallback(() => {
        setIsFocused(false);
        setFocusModeVisible(false);
    }, []);

    const closeFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
            focusAnimationTimerRef.current = null;
        }
        focusedInputRef.current?.blur();
        inputRef.current?.blur();
        Keyboard.dismiss();
        focusPresentation.value = withTiming(0, {
            duration: 180,
            easing: Easing.in(Easing.cubic),
        }, (finished) => {
            if (finished) {
                runOnJS(finishCloseFocusMode)();
            }
        });
    }, [finishCloseFocusMode, focusPresentation]);

    const selectAgent = React.useCallback((agent: NewSessionAgentType) => {
        const nextDefaults = resolveAgentDefaultConfig(defaultOverrides, agent);
        setAgentType(agent);
        setPermissionMode(nextDefaults.permissionMode);
        setModelMode(nextDefaults.modelMode);
        if (nextDefaults.effortLevel) setEffortLevel(nextDefaults.effortLevel);
    }, [defaultOverrides, setAgentType, setEffortLevel, setModelMode, setPermissionMode]);

    React.useEffect(() => {
        if (availableAgents.length > 0 && !availableAgents.some((agent) => agent.key === agentType)) {
            selectAgent(availableAgents[0].key);
        }
    }, [agentType, availableAgents, selectAgent]);

    type SettingsRow = {
        page: string;
        label: string;
        value: string;
        icon: React.ComponentProps<typeof Ionicons>['name'];
    };

    const environmentRows: SettingsRow[] = [
        { page: 'machine', label: 'MACHINE', value: currentMachine?.name ?? 'Select machine', icon: 'desktop-outline' },
        { page: 'project', label: 'PROJECT', value: currentProject?.name ?? '~', icon: 'folder-outline' },
        { page: 'worktree', label: 'WORKTREE', value: currentWorktree?.name ?? 'No worktree', icon: 'git-branch-outline' },
    ];
    const agentRows: SettingsRow[] = [
        { page: 'agent', label: 'AGENT', value: currentAgent.name, icon: 'hardware-chip-outline' },
        ...(currentModel ? [{ page: 'model', label: t('agentInput.model.title'), value: currentModel.name, icon: 'cube-outline' as const }] : []),
        ...(currentPermission ? [{ page: 'permission', label: t('agentInput.permissionMode.title'), value: currentPermission.name, icon: 'shield-outline' as const }] : []),
        ...(currentEffort ? [{ page: 'effort', label: t('agentInput.effort.title'), value: currentEffort.name, icon: 'speedometer-outline' as const }] : []),
    ];

    type PickerConfig = {
        title: string;
        options: ModeOption[];
        selectedKey: string | null | undefined;
        onSelect: (key: string) => void;
    };

    const requestCustomProjectPath = () => {
        Keyboard.dismiss();
        // Let the native menu finish dismissing before presenting the prompt.
        setTimeout(() => {
            void (async () => {
                const path = await Modal.prompt(
                    t('machineLauncher.enterCustomPath'),
                    undefined,
                    {
                        placeholder: '~/path/to/project',
                        defaultValue: selectedPath ?? '~',
                        confirmText: t('common.ok'),
                    },
                );
                const trimmedPath = path?.trim();
                if (trimmedPath) {
                    setPath(trimmedPath);
                }
            })();
        }, 220);
    };

    const getEnvironmentPickerConfig = (setting: EnvironmentSetting): PickerConfig => {
        if (setting === 'machine') {
            return { title: 'Machine', options: machineOptions, selectedKey: selectedMachineId, onSelect: setMachineId };
        }
        if (setting === 'project') {
            return {
                title: 'Project',
                options: [
                    ...projectOptions,
                    {
                        key: CUSTOM_PROJECT_PATH_KEY,
                        name: t('machineLauncher.enterCustomPath'),
                    },
                ],
                selectedKey: currentProject?.key,
                onSelect: (key) => {
                    if (key === CUSTOM_PROJECT_PATH_KEY) {
                        requestCustomProjectPath();
                        return;
                    }
                    setPath(key);
                },
            };
        }
        return {
            title: 'Worktree',
            options: worktreeOptions,
            selectedKey: selectedWorktreeKey,
            onSelect: (key) => {
                setSessionType(key === '__none__' ? 'simple' : 'worktree');
                setWorktreeKey(key === '__none__' || key === '__new__' ? null : key);
            },
        };
    };

    const getAgentPickerConfig = (setting: AgentSetting): PickerConfig => {
        if (setting === 'agent') {
            return { title: 'Agent', options: availableAgents, selectedKey: agentType, onSelect: (key) => selectAgent(key as NewSessionAgentType) };
        }
        if (setting === 'model') {
            return { title: t('agentInput.model.title'), options: modelOptions, selectedKey: currentModel?.key, onSelect: setModelMode };
        }
        if (setting === 'permission') {
            return { title: t('agentInput.permissionMode.title'), options: permissionOptions, selectedKey: currentPermission?.key, onSelect: setPermissionMode };
        }
        return { title: t('agentInput.effort.title'), options: effortOptions, selectedKey: currentEffort?.key, onSelect: setEffortLevel };
    };

    const agentSettingsGroups: NativeSettingsMenuGroup[] = agentRows.map((row) => {
        const config = getAgentPickerConfig(row.page as AgentSetting);
        return {
            key: row.page,
            label: row.value || config.title,
            systemImage: {
                agent: 'cpu',
                model: 'cube',
                permission: 'shield',
                effort: 'bolt',
            }[row.page],
            options: config.options.map((option) => ({ key: option.key, label: option.name })),
            selectedKey: config.selectedKey,
            onSelect: config.onSelect,
        };
    });
    const gearSettingsGroups = agentSettingsGroups.filter((group) => (
        group.key === 'agent' || group.key === 'permission'
    ));
    const modelSettingsGroup = agentSettingsGroups.find((group) => group.key === 'model');
    const effortSettingsGroup = agentSettingsGroups.find((group) => group.key === 'effort');

    const renderNativePicker = (row: SettingsRow, config: PickerConfig, compact: boolean) => (
        <NativeOptionsPicker
            key={row.page}
            title={config.title}
            triggerLabel={row.value}
            systemImage={{
                machine: 'desktopcomputer',
                project: 'folder',
                worktree: 'arrow.triangle.branch',
                agent: 'cpu',
                model: 'cube',
                permission: 'shield',
                effort: 'bolt',
            }[row.page]}
            options={config.options.map((option) => ({ key: option.key, label: option.name }))}
            selectedKey={config.selectedKey}
            onSelect={config.onSelect}
        >
            <View style={compact ? styles.focusConfigRow : styles.option}>
                <View style={styles.focusConfigIcon}>
                    <Ionicons
                        name={row.icon}
                        size={compact ? 21 : 18}
                        color={theme.colors.text}
                    />
                </View>
                {compact ? (
                    <Text style={styles.focusConfigValue} numberOfLines={1}>{row.value}</Text>
                ) : (
                    <View style={styles.optionCopy}>
                        <Text style={styles.optionLabel}>{row.label}</Text>
                        <Text style={styles.optionValue} numberOfLines={1}>{row.value}</Text>
                    </View>
                )}
                <View style={styles.focusConfigChevron}>
                    <Ionicons name="chevron-up" size={12} color={theme.colors.text} />
                    <Ionicons name="chevron-down" size={12} color={theme.colors.text} />
                </View>
            </View>
        </NativeOptionsPicker>
    );

    const renderEnvironmentPickers = () => environmentRows.map((row, index) => (
        <FocusConfigRevealRow
            key={row.page}
            progress={focusPresentation}
            index={index}
        >
            {renderNativePicker(row, getEnvironmentPickerConfig(row.page as EnvironmentSetting), true)}
        </FocusConfigRevealRow>
    ));

    const renderComposer = ({
        ref,
        onFocus,
        onBlur,
        onSend,
        activateOnPress,
    }: {
        ref: React.RefObject<TextInput | null>;
        onFocus: () => void;
        onBlur: () => void;
        onSend: () => void;
        activateOnPress?: () => void;
    }) => (
        <MobileGlassSurface
            nativeEffect
            intensity={78}
            glassEffectStyle="regular"
            style={styles.composerSurface}
        >
            <View style={styles.composerContent}>
                {activateOnPress ? (
                    <Pressable onPress={activateOnPress} style={styles.inputEntry}>
                        <Text
                            style={[styles.inputEntryText, !prompt && styles.inputEntryPlaceholder]}
                            numberOfLines={1}
                        >
                            {prompt || 'Plan, ask, build…'}
                        </Text>
                    </Pressable>
                ) : (
                    <TextInput
                        ref={ref}
                        value={prompt}
                        onChangeText={onPromptChange}
                        onSubmitEditing={() => canSubmit && onSend()}
                        onFocus={onFocus}
                        onBlur={onBlur}
                        placeholder="Plan, ask, build…"
                        placeholderTextColor={theme.colors.textSecondary}
                        selectionColor={theme.colors.text}
                        returnKeyType="send"
                        autoCorrect
                        style={styles.input}
                    />
                )}
                <BubblePressable
                    onPress={onSend}
                    disabled={!canSubmit}
                    style={[styles.sendButton, canSubmit && styles.sendButtonActive]}
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                >
                    {isSubmitting ? (
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    ) : (
                        <Ionicons
                            name="arrow-up"
                            size={16}
                            color={canSubmit ? '#111111' : theme.colors.textSecondary}
                        />
                    )}
                </BubblePressable>
            </View>
        </MobileGlassSurface>
    );

    const submit = async () => {
        if (!canSubmit) return false;
        useNewSessionDraft.getState().setAttachments(expImageUpload ? selectedImages : []);
        const started = await onSubmit();
        if (started) clearImages();
        return started;
    };

    const submitFromFocusMode = () => {
        if (!canSubmit) return;
        setFocusModeVisible(false);
        setIsFocused(false);
        void submit();
    };

    const renderFocusedComposer = () => (
        <Animated.View style={[styles.focusedComposerAnimationShell, focusedComposerAnimationStyle]}>
            <MobileGlassSurface
                nativeEffect
                intensity={78}
                glassEffectStyle="regular"
                style={[
                    styles.focusedComposerSurface,
                    styles.focusedComposerAnchored,
                    selectedImages.length > 0 && styles.focusedComposerSurfaceWithAttachments,
                ]}
            >
                <View style={styles.focusedComposerContent}>
                    <Animated.View style={[styles.focusedInputReveal, focusedInputRevealStyle]}>
                        {expImageUpload && (
                            <AgentInputAttachmentStrip images={selectedImages} onRemove={removeImage} />
                        )}
                        <TextInput
                            ref={focusedInputRef}
                            value={prompt}
                            onChangeText={onPromptChange}
                            onFocus={() => setIsFocused(true)}
                            placeholder="Ask Codex"
                            placeholderTextColor={theme.colors.textSecondary}
                            selectionColor={theme.colors.text}
                            autoCorrect
                            multiline
                            style={styles.focusedInput}
                        />
                    </Animated.View>
                    <Animated.View style={[styles.focusedComposerActions, focusedActionsRevealStyle]}>
                        {expImageUpload && (
                            <BubblePressable
                                onPress={() => void pickImages()}
                                style={styles.sideButton}
                                accessibilityRole="button"
                                accessibilityLabel="Add image"
                            >
                                <Ionicons name="add" size={26} color={theme.colors.text} />
                            </BubblePressable>
                        )}
                        <NativeSettingsMenu groups={gearSettingsGroups} style={styles.nativeGearMenu}>
                            <View style={styles.sideButton}>
                                <Ionicons name="settings-outline" size={20} color={theme.colors.text} />
                            </View>
                        </NativeSettingsMenu>
                        {modelSettingsGroup ? (
                            <NativeSettingsMenu groups={[modelSettingsGroup]} flat style={styles.nativeModeMenu}>
                                <View style={styles.focusedModeButton}>
                                    <Ionicons name="flash" size={18} color={theme.colors.text} />
                                    <Text style={styles.focusedModeText} numberOfLines={1}>
                                        {currentModel?.name ?? currentAgent.name}
                                    </Text>
                                </View>
                            </NativeSettingsMenu>
                        ) : (
                            <View style={styles.nativeModeMenu}>
                                <View style={styles.focusedModeButton}>
                                    <Ionicons name="flash" size={18} color={theme.colors.text} />
                                    <Text style={styles.focusedModeText} numberOfLines={1}>
                                        {currentAgent.name}
                                    </Text>
                                </View>
                            </View>
                        )}
                        {effortSettingsGroup && (
                            <NativeSettingsMenu groups={[effortSettingsGroup]} flat style={styles.nativeEffortMenu}>
                                <View style={styles.focusedEffortButton}>
                                    <Text style={styles.focusedModeSeparator}>·</Text>
                                    <Text style={styles.focusedModeText} numberOfLines={1}>
                                        {currentEffort?.name ?? t('agentInput.effort.title')}
                                    </Text>
                                </View>
                            </NativeSettingsMenu>
                        )}
                        <BubblePressable
                            onPress={submitFromFocusMode}
                            disabled={!canSubmit}
                            style={[styles.sendButton, styles.focusedSendButton, canSubmit && styles.sendButtonActive]}
                            accessibilityRole="button"
                            accessibilityLabel="Send"
                        >
                        {isSubmitting ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        ) : (
                            <Ionicons
                                name="arrow-up"
                                size={16}
                                color={canSubmit ? '#111111' : theme.colors.textSecondary}
                            />
                        )}
                        </BubblePressable>
                    </Animated.View>
                </View>
            </MobileGlassSurface>
        </Animated.View>
    );

    return (
        <>
            <Animated.View
                pointerEvents="box-none"
                style={[styles.keyboardFollower, keyboardStyle]}
            >
                <View
                    pointerEvents="box-none"
                    style={[
                        styles.safeArea,
                        { paddingBottom: isFocused ? 8 : Math.max(10, safeArea.bottom) },
                    ]}
                >
                    {renderComposer({
                        ref: inputRef,
                        onFocus: openFocusMode,
                        onBlur: () => {
                            if (!focusModeVisible) setIsFocused(false);
                        },
                        onSend: submit,
                        activateOnPress: openFocusMode,
                    })}
                </View>
            </Animated.View>

            <RNModal
                visible={focusModeVisible}
                transparent
                animationType="none"
                onRequestClose={closeFocusMode}
            >
                <View style={styles.modalRoot}>
                    <Animated.View
                        pointerEvents="box-none"
                        style={[styles.modalBackdrop, styles.focusBackdrop, focusBackdropStyle]}
                    >
                        <Pressable
                            style={styles.modalBackdrop}
                            onPress={closeFocusMode}
                        />
                    </Animated.View>
                    <Animated.View style={[
                        styles.focusBackPosition,
                        { top: safeArea.top + 14 },
                        focusBackButtonStyle,
                    ]}>
                        <MobileGlassSurface
                            nativeEffect
                            interactive
                            intensity={80}
                            glassEffectStyle="regular"
                            style={styles.focusBackSurface}
                        >
                            <BubblePressable
                                onPress={closeFocusMode}
                                style={styles.focusBackButton}
                                pressedStyle={styles.sideButtonPressed}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.back')}
                            >
                                <Ionicons name="chevron-back" size={27} color={theme.colors.text} />
                            </BubblePressable>
                        </MobileGlassSurface>
                    </Animated.View>

                    <Animated.View style={[styles.focusDock, keyboardStyle]}>
                        <View style={styles.focusConfig}>
                            <View style={styles.focusConfigGroup}>
                                {renderEnvironmentPickers()}
                            </View>
                        </View>
                        <View style={[
                            styles.focusComposerArea,
                            { paddingBottom: safeArea.bottom + 8 },
                        ]}>
                            {renderFocusedComposer()}
                        </View>
                    </Animated.View>
                </View>
            </RNModal>

        </>
    );
});
