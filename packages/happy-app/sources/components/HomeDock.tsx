import * as React from 'react';
import { ActivityIndicator, Keyboard, LayoutChangeEvent, Modal as RNModal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
import { NativeSettingsMenu, type NativeSettingsMenuGroup, type NativeSettingsMenuProps } from './NativeSettingsMenu';
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
import { resolveMultiTextInputLayout } from './multiTextInputLayout';
import {
    isHomeDockOptionSelectable,
    resolveCustomProjectPathSelection,
    resolveHomeDockBackdropPressAction,
    resolveHomeDockMachineSelection,
    resolveHomeDockPickerBackAction,
    resolveHomeDockPromptPlaceholder,
    shouldUseNativeHomeDockMenus,
} from './homeDockInteraction';
import { registerHomeDockFocusListener, useHomeDockFocusStore } from './homeDockFocus';
import { resolveMachineAgent } from '@/utils/newSessionAgentSelection';
import { findConnectedRigMachine, getRigMachineSessionCreation } from '@/sync/rigSessionCreation';
import {
    MobileHeaderScrim,
    MOBILE_HOME_SCRIM_OVERLAY_OPACITY,
} from './navigation/MobileHeaderScrim';
import {
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerActionGeometry,
    resolveMobileComposerActionRowGeometry,
    resolveMobileCollapsedComposerGeometry,
    resolveMobileComposerHeight,
    resolveMobileComposerMenuGeometry,
} from './agentInputLayout';

export const MOBILE_HOME_DOCK_CONTENT_INSET = 108;

type EnvironmentSetting = 'machine' | 'project' | 'worktree';
type AgentSetting = 'agent' | 'model' | 'permission' | 'effort';
type PickerPage = EnvironmentSetting | AgentSetting;

const CUSTOM_PROJECT_PATH_KEY = '__custom_project_path__';

const AGENTS: Array<{ key: NewSessionAgentType; name: string }> = [
    { key: 'rig', name: 'Rig' },
    { key: 'claude', name: 'Claude Code' },
    { key: 'codex', name: 'Codex' },
    { key: 'openclaw', name: 'OpenClaw' },
    { key: 'gemini', name: 'Gemini' },
    { key: 'agy', name: 'Agy' },
];

const MOBILE_ICON_MENU_GEOMETRY = resolveMobileComposerMenuGeometry('icon');
const MOBILE_MODEL_MENU_GEOMETRY = resolveMobileComposerMenuGeometry('model');
const MOBILE_EFFORT_MENU_GEOMETRY = resolveMobileComposerMenuGeometry('effort');
const MOBILE_ACTION_ROW_GEOMETRY = resolveMobileComposerActionRowGeometry();
const MOBILE_ICON_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('icon');
const MOBILE_PRIMARY_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('primary');
const MOBILE_COLLAPSED_COMPOSER_GEOMETRY = resolveMobileCollapsedComposerGeometry();

const styles = StyleSheet.create((theme) => ({
    keyboardFollower: {
        width: '100%',
    },
    // Reaches above the dock so the scrim's ramp lands on content rather than
    // on the composer itself.
    bottomBackdrop: {
        ...StyleSheet.absoluteFillObject,
        top: -26,
    },
    safeArea: {
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    // The focused composer replaces the resting one rather than covering it:
    // the modal sits a safe-area inset higher, so leaving this on screen showed
    // its send button peeking out below. `display` rather than `opacity` because
    // an ancestor below full alpha kills the native blur underneath.
    safeAreaBehindFocus: {
        display: 'none',
    },
    composerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.shellHeight,
        alignSelf: 'center',
        borderRadius: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.shellRadius,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        // Frosted glass is supplied by MobileGlassSurface on native. The dense
        // material tint keeps backdrop detail from competing with this input.
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    composerShadow: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.shellRadius,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: theme.dark ? 6 : 2 },
        shadowOpacity: theme.dark ? 0.22 : 0.08,
        shadowRadius: theme.dark ? 16 : 8,
        elevation: theme.dark ? 4 : 2,
    },
    composerContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.contentPaddingLeft,
        paddingRight: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.contentPaddingRight,
        gap: 4,
    },
    sideButton: MOBILE_ICON_ACTION_GEOMETRY,
    sideButtonPressed: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    input: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        paddingLeft: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingLeft,
        paddingRight: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingRight,
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
        paddingLeft: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingLeft,
        paddingRight: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingRight,
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
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    focusedComposerAnimationShell: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        overflow: 'hidden',
    },
    focusedComposerShadow: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: theme.dark ? 6 : 2 },
        shadowOpacity: theme.dark ? 0.22 : 0.08,
        shadowRadius: theme.dark ? 16 : 8,
        elevation: theme.dark ? 4 : 2,
    },
    focusedComposerAnchored: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusedComposerContent: {
        flex: 1,
        paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset,
        paddingTop: MOBILE_COMPOSER_METRICS.shellPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.shellPaddingBottom,
    },
    focusedInput: {
        flex: 1,
        width: '100%',
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        color: theme.colors.text,
        fontSize: MOBILE_COMPOSER_METRICS.inputFontSize,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        textAlignVertical: 'top',
        ...Typography.default(),
    },
    focusedInputMeasurement: {
        position: 'absolute',
        left: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        right: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        opacity: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        fontSize: MOBILE_COMPOSER_METRICS.inputFontSize,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        ...Typography.default(),
    },
    focusedInputReveal: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 0,
        paddingLeft: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        paddingRight: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    },
    focusedComposerActions: MOBILE_ACTION_ROW_GEOMETRY,
    nativeIconMenuFrame: MOBILE_ICON_MENU_GEOMETRY.frame,
    nativeIconMenuContent: MOBILE_ICON_MENU_GEOMETRY.content,
    nativeModeMenu: MOBILE_MODEL_MENU_GEOMETRY.frame,
    focusedModeButton: MOBILE_MODEL_MENU_GEOMETRY.content,
    nativeEffortMenu: MOBILE_EFFORT_MENU_GEOMETRY.frame,
    focusedEffortButton: MOBILE_EFFORT_MENU_GEOMETRY.content,
    focusedModeText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    focusedModeSeparator: {
        flexShrink: 0,
        color: theme.colors.textSecondary,
        fontSize: 14,
        ...Typography.default(),
    },
    sendButton: {
        ...MOBILE_PRIMARY_ACTION_GEOMETRY,
        backgroundColor: theme.colors.surfaceHighest,
    },
    sendButtonActive: {
        backgroundColor: theme.dark ? '#F5F5F5' : theme.colors.button.primary.background,
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
        backgroundColor: theme.dark ? 'rgba(0, 0, 0, 0.88)' : 'rgba(255, 255, 255, 0.88)',
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
    optionDisabled: {
        opacity: 0.45,
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
    showBottomBackdrop = true,
}: {
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => Promise<boolean>;
    isSubmitting: boolean;
    showBottomBackdrop?: boolean;
}) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const inputRef = React.useRef<TextInput>(null);
    const focusedInputRef = React.useRef<TextInput>(null);
    const mountedRef = React.useRef(true);
    const focusAnimationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeMenuOpenRef = React.useRef(false);
    const focusPresentation = useSharedValue(0);
    const [isFocused, setIsFocused] = React.useState(false);
    const [focusModeVisible, setFocusModeVisible] = React.useState(false);
    const [focusedInputContentHeight, setFocusedInputContentHeight] = React.useState(0);
    // Expo's Compose bridge can freeze a DropdownMenu trigger at 0x0 when it
    // composes before React Native measures its child. Keep iOS/web unchanged,
    // and use an in-modal React Native picker only on Android.
    const useNativeMenus = shouldUseNativeHomeDockMenus(Platform.OS);
    const [sheetPage, setSheetPage] = React.useState<PickerPage | null>(null);
    const [sheetRootVisible, setSheetRootVisible] = React.useState(false);
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
    const resolvedMachineId = resolveHomeDockMachineSelection(
        selectedMachineId,
        machineOptions.map((machine) => machine.key),
    );

    React.useEffect(() => {
        if (resolvedMachineId !== selectedMachineId) {
            setMachineId(resolvedMachineId);
        }
    }, [resolvedMachineId, selectedMachineId, setMachineId]);

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
    const selectedRigCreation = React.useMemo(
        () => getRigMachineSessionCreation(selectedMachine?.metadata),
        [selectedMachine?.metadata],
    );
    const connectedRigMachine = React.useMemo(
        () => findConnectedRigMachine(machines),
        [machines],
    );
    const selectedRigIsConnected = selectedRigCreation !== null
        && selectedMachine !== null
        && isMachineOnline(selectedMachine);
    const rigSelectionMachine = selectedRigIsConnected ? selectedMachine : connectedRigMachine;
    const rigSelectionCreation = selectedRigIsConnected
        ? selectedRigCreation
        : getRigMachineSessionCreation(connectedRigMachine?.metadata);
    const rigCreation = agentType === 'rig' ? rigSelectionCreation : null;
    const supportsWorktree = selectedMachine?.metadata?.rigOnly === true
        ? selectedRigCreation?.supportsWorktrees ?? false
        : rigCreation?.supportsWorktrees ?? getSupportsWorktree(agentType);
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
    // Every agent stays listed so the picker always reads as a choice. The ones
    // the selected machine has no CLI for are disabled rather than hidden, which
    // otherwise leaves a single checked row that looks like it does nothing.
    const availableAgents = React.useMemo<ModeOption[]>(() => {
        const availability = selectedMachine?.metadata?.cliAvailability;
        return AGENTS.map((agent) => {
            const available = agent.key === 'rig'
                ? rigSelectionMachine !== null
                : !availability || availability[agent.key];
            return available
                ? agent
                : {
                    ...agent,
                    disabled: true,
                    description: agent.key === 'rig'
                        ? 'Select a connected Rig machine'
                        : 'Not installed on this machine',
                };
        });
    }, [rigSelectionMachine, selectedMachine]);
    const resolvedAgentType = agentType === 'rig' && !rigSelectionMachine
        ? (availableAgents.find((agent) => !agent.disabled && agent.key !== 'rig')?.key as NewSessionAgentType | undefined) ?? agentType
        : agentType === 'rig'
            ? agentType
            : resolveMachineAgent(agentType, selectedMachine?.metadata?.cliAvailability);
    const defaults = React.useMemo(() => rigCreation
        ? {
            permissionMode: rigCreation.defaultPermissionMode ?? '',
            modelMode: rigCreation.defaultModelKey ?? '',
            effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
        }
        : resolveAgentDefaultConfig(defaultOverrides, agentType), [agentType, defaultOverrides, rigCreation]);
    const permissionOptions = React.useMemo(
        () => rigCreation?.permissionModes ?? getHardcodedPermissionModes(agentType, t),
        [agentType, rigCreation],
    );
    const modelOptions = React.useMemo(
        () => rigCreation?.models ?? getHardcodedModelModes(agentType, t),
        [agentType, rigCreation],
    );
    const currentPermission = resolveOption(permissionOptions, [permissionMode, defaults.permissionMode]);
    const currentModel = resolveOption(modelOptions, [modelMode, defaults.modelMode]);
    const effortOptions = React.useMemo(
        () => rigCreation
            ? rigCreation.effortsForModel(currentModel?.key).map((key) => ({ key, name: key }))
            : getEffortLevelsForModel(agentType, currentModel?.key ?? 'default'),
        [agentType, currentModel?.key, rigCreation],
    );
    const currentEffortDefault = rigCreation?.defaultEffortForModel(currentModel?.key)
        ?? defaults.effortLevel;
    const currentEffort = resolveOption(effortOptions, [effortLevel, currentEffortDefault]);
    const currentAgent = availableAgents.find((agent) => agent.key === agentType) ?? availableAgents[0] ?? AGENTS[0];
    const focusedPromptPlaceholder = resolveHomeDockPromptPlaceholder(currentAgent.key, currentAgent.name);
    const canSubmit = !isSubmitting && (
        prompt.trim().length > 0 || (expImageUpload && selectedImages.length > 0)
    );
    const focusedInputLayout = resolveMultiTextInputLayout({
        contentHeight: focusedInputContentHeight,
        hasText: prompt.length > 0,
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    });
    const focusedInputContainerHeight = Math.max(
        MOBILE_COMPOSER_METRICS.inputMinHeight,
        focusedInputLayout.height
            + MOBILE_COMPOSER_METRICS.inputPaddingTop
            + MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    );
    const focusedComposerHeight = resolveMobileComposerHeight(
        focusedInputLayout.height,
        selectedImages.length > 0,
    );
    const handleFocusedInputMeasurement = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setFocusedInputContentHeight((currentHeight) => (
            currentHeight === nextHeight ? currentHeight : nextHeight
        ));
    }, []);
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

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (focusAnimationTimerRef.current) {
                clearTimeout(focusAnimationTimerRef.current);
            }
        };
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
        nativeMenuOpenRef.current = false;
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

    // A "+" in the session list prefills the draft and then asks the dock to
    // open. The last id seen is captured on mount so a remount after an earlier
    // request does not re-open the composer on its own.
    const focusRequestId = useHomeDockFocusStore((state) => state.requestId);
    const servedFocusRequestRef = React.useRef(focusRequestId);
    React.useEffect(() => registerHomeDockFocusListener(), []);
    React.useEffect(() => {
        if (focusRequestId === servedFocusRequestRef.current) return;
        servedFocusRequestRef.current = focusRequestId;
        openFocusMode();
    }, [focusRequestId, openFocusMode]);

    const finishCloseFocusMode = React.useCallback(() => {
        nativeMenuOpenRef.current = false;
        setIsFocused(false);
        setFocusModeVisible(false);
        setSheetPage(null);
        setSheetRootVisible(false);
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

    const closePicker = React.useCallback(() => {
        setSheetPage(null);
        setSheetRootVisible(false);
    }, []);

    const handleFocusModeRequestClose = React.useCallback(() => {
        const action = resolveHomeDockPickerBackAction({
            hasPage: sheetPage !== null,
            rootVisible: sheetRootVisible,
        });
        if (action === 'show-root') {
            setSheetPage(null);
            return;
        }
        if (action === 'close-picker') {
            closePicker();
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, closePicker, sheetPage, sheetRootVisible]);

    const selectAgent = React.useCallback((agent: NewSessionAgentType) => {
        const nextRigCreation = agent === 'rig' ? rigSelectionCreation : null;
        const nextDefaults = nextRigCreation
            ? {
                permissionMode: nextRigCreation.defaultPermissionMode ?? '',
                modelMode: nextRigCreation.defaultModelKey ?? '',
                effortLevel: nextRigCreation.defaultEffortForModel(nextRigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agent);
        if (agent === 'rig' && rigSelectionMachine && rigSelectionMachine.id !== selectedMachineId) {
            setMachineId(rigSelectionMachine.id);
        }
        setAgentType(agent);
        setPermissionMode(nextDefaults.permissionMode);
        setModelMode(nextDefaults.modelMode);
        if (nextDefaults.effortLevel) setEffortLevel(nextDefaults.effortLevel);
    }, [defaultOverrides, rigSelectionCreation, rigSelectionMachine, selectedMachineId, setAgentType, setEffortLevel, setMachineId, setModelMode, setPermissionMode]);

    React.useEffect(() => {
        if (agentType === 'rig' && rigSelectionMachine && rigSelectionMachine.id !== selectedMachineId) {
            setMachineId(rigSelectionMachine.id);
        }
    }, [agentType, rigSelectionMachine, selectedMachineId, setMachineId]);

    React.useEffect(() => {
        if (resolvedAgentType !== agentType) {
            selectAgent(resolvedAgentType);
        }
    }, [agentType, resolvedAgentType, selectAgent]);

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
        // Native menu actions are already deferred until dismissal by the
        // picker wrapper, so presenting another delayed task here creates a
        // stale prompt race when HomeDock unmounts.
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
            const selectedCustomPath = resolveCustomProjectPathSelection(path, mountedRef.current);
            if (selectedCustomPath) {
                setPath(selectedCustomPath);
            }
        })();
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
            title: config.title,
            systemImage: {
                agent: 'cpu',
                model: 'cube',
                permission: 'shield',
                effort: 'bolt',
            }[row.page],
            options: config.options.map((option) => ({
                key: option.key,
                label: option.name,
                disabled: option.disabled,
            })),
            selectedKey: config.selectedKey,
            onSelect: config.onSelect,
        };
    });
    const gearSettingsGroups = agentSettingsGroups.filter((group) => (
        group.key === 'agent' || group.key === 'permission'
    ));
    const modelSettingsGroup = agentSettingsGroups.find((group) => group.key === 'model');
    const effortSettingsGroup = agentSettingsGroups.find((group) => group.key === 'effort');

    const getPickerConfig = (page: PickerPage): PickerConfig => (
        page === 'machine' || page === 'project' || page === 'worktree'
            ? getEnvironmentPickerConfig(page)
            : getAgentPickerConfig(page)
    );
    const sheetVisible = !useNativeMenus && (sheetRootVisible || sheetPage !== null);
    const markNativeMenuOpen = React.useCallback(() => {
        nativeMenuOpenRef.current = true;
    }, []);
    const handleFocusBackdropPress = React.useCallback(() => {
        const action = resolveHomeDockBackdropPressAction({
            nativeMenuOpen: useNativeMenus && nativeMenuOpenRef.current,
            pickerVisible: sheetVisible,
        });
        nativeMenuOpenRef.current = false;
        if (action === 'dismiss-menu') {
            return;
        }
        if (action === 'close-picker') {
            closePicker();
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, closePicker, sheetVisible, useNativeMenus]);

    const renderPickerRowContent = (row: SettingsRow, compact: boolean) => (
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
        </View>
    );

    const renderPickerRow = (row: SettingsRow, config: PickerConfig, compact: boolean) => {
        if (!useNativeMenus) {
            return (
                <Pressable
                    key={row.page}
                    onPress={() => {
                        setSheetRootVisible(false);
                        setSheetPage(row.page as PickerPage);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${row.label}: ${row.value}`}
                >
                    {renderPickerRowContent(row, compact)}
                </Pressable>
            );
        }
        return (
            <NativeOptionsPicker
                key={row.page}
                title={config.title}
                tintColor={compact ? theme.colors.text : undefined}
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
                onMenuOpen={markNativeMenuOpen}
                onSelect={(key) => {
                    nativeMenuOpenRef.current = false;
                    config.onSelect(key);
                }}
            >
                {renderPickerRowContent(row, compact)}
            </NativeOptionsPicker>
        );
    };

    const renderEnvironmentPickers = () => environmentRows.map((row, index) => (
        <FocusConfigRevealRow
            key={row.page}
            progress={focusPresentation}
            index={index}
        >
            {renderPickerRow(row, getEnvironmentPickerConfig(row.page as EnvironmentSetting), true)}
        </FocusConfigRevealRow>
    ));

    const renderMenuControl = ({
        page,
        groups,
        flat,
        style,
        accessibilityLabel,
        triggerSystemImage,
        triggerLabel,
        triggerAlignment,
        children,
    }: {
        page: PickerPage | 'root';
        groups: NativeSettingsMenuGroup[];
        flat?: boolean;
        style: NativeSettingsMenuProps['style'];
        accessibilityLabel: string;
        triggerSystemImage?: NativeSettingsMenuProps['triggerSystemImage'];
        triggerLabel?: NativeSettingsMenuProps['triggerLabel'];
        triggerAlignment?: NativeSettingsMenuProps['triggerAlignment'];
        children: React.ReactNode;
    }) => {
        if (!useNativeMenus) {
            return (
                <Pressable
                    onPress={() => {
                        if (page === 'root') {
                            setSheetPage(null);
                            setSheetRootVisible(true);
                            return;
                        }
                        setSheetRootVisible(false);
                        setSheetPage(page);
                    }}
                    style={style}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                >
                    {children}
                </Pressable>
            );
        }
        return (
            <NativeSettingsMenu
                accessibilityLabel={accessibilityLabel}
                groups={groups.map((group) => ({
                    ...group,
                    onSelect: (key) => {
                        nativeMenuOpenRef.current = false;
                        group.onSelect(key);
                    },
                }))}
                onMenuOpen={markNativeMenuOpen}
                flat={flat}
                style={style}
                triggerSystemImage={triggerSystemImage}
                triggerLabel={triggerLabel}
                triggerAlignment={triggerAlignment}
            >
                {children}
            </NativeSettingsMenu>
        );
    };

    const sheetRootRows = agentRows.filter((row) => (
        row.page === 'agent' || row.page === 'permission'
    ));

    const renderSettingsSheet = () => {
        const config = sheetPage ? getPickerConfig(sheetPage) : null;
        const canGoBack = sheetPage !== null && sheetRootVisible;
        return (
            <View style={styles.settingsStack}>
                <MobileGlassSurface
                    nativeEffect
                    intensity={78}
                    glassEffectStyle="regular"
                    style={styles.settingsSurface}
                >
                    <View style={styles.settingsHeader}>
                        <Pressable
                            onPress={() => (canGoBack ? setSheetPage(null) : closePicker())}
                            style={styles.backButton}
                            accessibilityRole="button"
                            accessibilityLabel={canGoBack ? t('common.back') : t('common.cancel')}
                        >
                            <Ionicons
                                name={canGoBack ? 'chevron-back' : 'close'}
                                size={canGoBack ? 22 : 20}
                                color={theme.colors.text}
                            />
                        </Pressable>
                        <Text style={styles.settingsTitle} numberOfLines={1}>
                            {config?.title ?? t('settings.title')}
                        </Text>
                    </View>
                    <ScrollView style={styles.optionList} keyboardShouldPersistTaps="always">
                        {config ? config.options.map((option) => {
                            const selectable = isHomeDockOptionSelectable(option.disabled);
                            const selected = option.key === config.selectedKey;
                            return (
                                <Pressable
                                    key={option.key}
                                    disabled={!selectable}
                                    onPress={() => {
                                        if (!selectable) return;
                                        config.onSelect(option.key);
                                        closePicker();
                                    }}
                                    style={({ pressed }) => [
                                        styles.option,
                                        !selectable && styles.optionDisabled,
                                        pressed && selectable && styles.optionPressed,
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: !selectable, selected }}
                                >
                                    <View style={styles.focusConfigIcon}>
                                        {selected && (
                                            <Ionicons name="checkmark" size={16} color={theme.colors.text} />
                                        )}
                                    </View>
                                    <View style={styles.optionCopy}>
                                        <Text style={styles.optionValue} numberOfLines={1}>{option.name}</Text>
                                        {!!option.description && (
                                            <Text style={styles.optionDescription} numberOfLines={2}>
                                                {option.description}
                                            </Text>
                                        )}
                                    </View>
                                </Pressable>
                            );
                        }) : sheetRootRows.map((row) => (
                            <Pressable
                                key={row.page}
                                onPress={() => setSheetPage(row.page as PickerPage)}
                                style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                                accessibilityRole="button"
                                accessibilityLabel={`${row.label}: ${row.value}`}
                            >
                                <View style={styles.focusConfigIcon}>
                                    <Ionicons name={row.icon} size={18} color={theme.colors.text} />
                                </View>
                                <View style={styles.optionCopy}>
                                    <Text style={styles.optionLabel}>{row.label}</Text>
                                    <Text style={styles.optionValue} numberOfLines={1}>{row.value}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                            </Pressable>
                        ))}
                    </ScrollView>
                </MobileGlassSurface>
            </View>
        );
    };

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
        <View style={styles.composerShadow}>
            <MobileGlassSurface
                nativeEffect
                material="frosted"
                intensity={92}
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
                                color={canSubmit
                                    ? theme.dark ? '#111111' : theme.colors.button.primary.tint
                                    : theme.colors.textSecondary}
                            />
                        )}
                    </BubblePressable>
                </View>
            </MobileGlassSurface>
        </View>
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
        closePicker();
        void submit();
    };

    const renderFocusedComposer = () => (
        <View style={styles.focusedComposerShadow}>
            <Animated.View style={[styles.focusedComposerAnimationShell, focusedComposerAnimationStyle]}>
                <MobileGlassSurface
                    nativeEffect
                    material="frosted"
                    intensity={92}
                    style={[
                        styles.focusedComposerSurface,
                        styles.focusedComposerAnchored,
                        { height: focusedComposerHeight },
                    ]}
                >
                <View style={styles.focusedComposerContent}>
                    {expImageUpload && selectedImages.length > 0 && (
                        <Animated.View style={focusedInputRevealStyle}>
                            <AgentInputAttachmentStrip images={selectedImages} onRemove={removeImage} />
                        </Animated.View>
                    )}
                    <Animated.View style={[
                        styles.focusedInputReveal,
                        { height: focusedInputContainerHeight },
                        focusedInputRevealStyle,
                    ]}>
                        <Text
                            accessible={false}
                            pointerEvents="none"
                            onLayout={handleFocusedInputMeasurement}
                            style={styles.focusedInputMeasurement}
                        >
                            {prompt || ' '}
                        </Text>
                        <TextInput
                            ref={focusedInputRef}
                            value={prompt}
                            onChangeText={onPromptChange}
                            onFocus={() => setIsFocused(true)}
                            placeholder={focusedPromptPlaceholder}
                            placeholderTextColor={theme.colors.textSecondary}
                            selectionColor={theme.colors.text}
                            autoCorrect
                            multiline
                            scrollEnabled={focusedInputLayout.scrollEnabled}
                            style={[styles.focusedInput, { height: focusedInputLayout.height }]}
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
                                <Ionicons
                                    name="add"
                                    size={MOBILE_COMPOSER_METRICS.addIconSize}
                                    color={theme.colors.text}
                                />
                            </BubblePressable>
                        )}
                        {renderMenuControl({
                            page: 'root',
                            groups: gearSettingsGroups,
                            style: styles.nativeIconMenuFrame,
                            accessibilityLabel: t('settings.title'),
                            triggerSystemImage: 'gearshape',
                            children: (
                                <View style={styles.nativeIconMenuContent}>
                                    <Ionicons name="settings-outline" size={20} color={theme.colors.text} />
                                </View>
                            ),
                        })}
                        {/* Pushes model/effort right so the pair sits against the
                            send button instead of drifting when a label changes. */}
                        <View style={{ flex: 1 }} />
                        {modelSettingsGroup ? (
                            renderMenuControl({
                                page: 'model',
                                groups: [modelSettingsGroup],
                                flat: true,
                                style: styles.nativeModeMenu,
                                accessibilityLabel: t('agentInput.model.title'),
                                triggerLabel: currentModel?.name ?? currentAgent.name,
                                triggerAlignment: 'trailing',
                                children: (
                                    <View style={styles.focusedModeButton}>
                                        <Text style={styles.focusedModeText} numberOfLines={1}>
                                            {currentModel?.name ?? currentAgent.name}
                                        </Text>
                                    </View>
                                ),
                            })
                        ) : (
                            <View style={styles.nativeModeMenu}>
                                <View style={styles.focusedModeButton}>
                                    <Text style={styles.focusedModeText} numberOfLines={1}>
                                        {currentAgent.name}
                                    </Text>
                                </View>
                            </View>
                        )}
                        {/* The separator is its own element rather than part of the
                            effort label, which would wrap it onto a second line
                            inside the narrow trigger. */}
                        {effortSettingsGroup && (
                            <Text style={styles.focusedModeSeparator}>·</Text>
                        )}
                        {effortSettingsGroup && renderMenuControl({
                            page: 'effort',
                            groups: [effortSettingsGroup],
                            flat: true,
                            style: styles.nativeEffortMenu,
                            accessibilityLabel: t('agentInput.effort.title'),
                            triggerLabel: currentEffort?.name ?? t('agentInput.effort.title'),
                            triggerAlignment: 'leading',
                            children: (
                                <View style={styles.focusedEffortButton}>
                                    <Text style={styles.focusedModeText} numberOfLines={1}>
                                        {currentEffort?.name ?? t('agentInput.effort.title')}
                                    </Text>
                                </View>
                            ),
                        })}
                        <BubblePressable
                            onPress={submitFromFocusMode}
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
                                color={canSubmit
                                    ? theme.dark ? '#111111' : theme.colors.button.primary.tint
                                    : theme.colors.textSecondary}
                            />
                        )}
                        </BubblePressable>
                    </Animated.View>
                </View>
                </MobileGlassSurface>
            </Animated.View>
        </View>
    );

    return (
        <>
            <Animated.View
                pointerEvents="box-none"
                style={[styles.keyboardFollower, keyboardStyle]}
            >
                {showBottomBackdrop && (
                    <View pointerEvents="none" style={styles.bottomBackdrop}>
                        <MobileHeaderScrim
                            variant="strong"
                            edge="bottom"
                            overlayOpacity={MOBILE_HOME_SCRIM_OVERLAY_OPACITY}
                        />
                    </View>
                )}
                <View
                    pointerEvents={focusModeVisible ? 'none' : 'box-none'}
                    style={[
                        styles.safeArea,
                        { paddingBottom: isFocused ? 8 : Math.max(10, safeArea.bottom) },
                        focusModeVisible && styles.safeAreaBehindFocus,
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
                onRequestClose={handleFocusModeRequestClose}
            >
                <View style={styles.modalRoot}>
                    <Animated.View
                        pointerEvents="box-none"
                        style={[styles.modalBackdrop, styles.focusBackdrop, focusBackdropStyle]}
                    >
                        <Pressable
                            style={styles.modalBackdrop}
                            onPress={handleFocusBackdropPress}
                        />
                    </Animated.View>
                    {/* No back affordance here on purpose: tapping the backdrop
                        already closes focus mode, and a floating chevron over the
                        session list is redundant chrome. */}

                    <Animated.View style={[styles.focusDock, keyboardStyle]}>
                        <View style={styles.focusConfig}>
                            {sheetVisible ? renderSettingsSheet() : (
                                <View style={styles.focusConfigGroup}>
                                    {renderEnvironmentPickers()}
                                </View>
                            )}
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
