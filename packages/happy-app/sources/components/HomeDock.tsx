import * as React from 'react';
import { ActivityIndicator, Keyboard, LayoutChangeEvent, Modal as RNModal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    interpolateColor,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
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
import { getCodeAgentDefaults, resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { formatLastSeen, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { listWorktrees } from '@/utils/worktree';
import { collectSessionPlaces, collectSessionWorkspaces } from '@/sync/agentSessionPlaces';
import {
    collectMachineChoices,
    findMachineChoice,
    machineChoiceAgentAvailable,
    machineChoiceAgentVisible,
    resolveChoiceAgent,
    resolveWorktreeCreationMachine,
} from '@/sync/machineChoices';
import type { Session } from '@/sync/storageTypes';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    filterPermissionModesForCli,
    getSupportsWorktree,
    includeConfiguredModel,
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
import {
    resolveNewSessionPrimaryAction,
    resolveNewSessionProgressLabel,
    type NewSessionStartPhase,
} from './newSessionProgress';
import { StatusDot } from './StatusDot';
import { Shaker, type ShakeInstance } from './Shaker';
import { hapticsError } from './haptics';
import { HARNESS_ORDER, getHarnessName } from '@/utils/harnessCatalog';
import { getPermissionModeMenuLabel, getPermissionModeShortLabel } from '@/utils/permissionModeLabels';
import { getRigMachineSessionCreation } from '@/sync/rigSessionCreation';
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

const MOBILE_MODEL_MENU_GEOMETRY = resolveMobileComposerMenuGeometry('model');
const MOBILE_EFFORT_MENU_GEOMETRY = resolveMobileComposerMenuGeometry('effort');
const MOBILE_PERMISSION_MENU_GEOMETRY = resolveMobileComposerMenuGeometry('permission');
const MOBILE_ACTION_ROW_GEOMETRY = resolveMobileComposerActionRowGeometry();
const MOBILE_ICON_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('icon');
const MOBILE_PRIMARY_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('primary');
const MOBILE_COLLAPSED_COMPOSER_GEOMETRY = resolveMobileCollapsedComposerGeometry();
const MOBILE_HOME_DOCK_TOP_PADDING = 8;
// Sits in the gap the focused dock already leaves above the composer, so it
// costs no layout: showing it must not move the pickers or the composer.
const START_PROGRESS_ROW_HEIGHT = 18;
// Matches Shaker's own keyframes so a refused picker reads the same as every
// other refusal in the app.
const SHAKE_KEYFRAMES = [3, -3, 3, -3, 0];

const styles = StyleSheet.create((theme) => ({
    keyboardFollower: {
        width: '100%',
    },
    // Keep the content clear until the composer's midpoint. From there the
    // bottom scrim begins feathering over content that scrolls beneath it;
    // above that point the composer shadow provides the only separation.
    bottomBackdrop: {
        ...StyleSheet.absoluteFillObject,
        top: MOBILE_HOME_DOCK_TOP_PADDING
            + MOBILE_COLLAPSED_COMPOSER_GEOMETRY.shellHeight / 2,
    },
    safeArea: {
        paddingHorizontal: 16,
        paddingTop: MOBILE_HOME_DOCK_TOP_PADDING,
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
    nativeModeMenu: MOBILE_MODEL_MENU_GEOMETRY.frame,
    focusedModeButton: MOBILE_MODEL_MENU_GEOMETRY.content,
    nativeEffortMenu: MOBILE_EFFORT_MENU_GEOMETRY.frame,
    focusedEffortButton: MOBILE_EFFORT_MENU_GEOMETRY.content,
    nativePermissionMenu: MOBILE_PERMISSION_MENU_GEOMETRY.frame,
    focusedPermissionButton: MOBILE_PERMISSION_MENU_GEOMETRY.content,
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
    primaryActionFlash: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: MOBILE_PRIMARY_ACTION_GEOMETRY.borderRadius,
        backgroundColor: theme.dark ? '#4A4A4E' : '#FFFFFF',
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
    focusBackdropDim: {
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
        // Clears the status line that sits below it, which is placed out of
        // layout: the pickers hold this gap open whether or not it is filled.
        paddingBottom: START_PROGRESS_ROW_HEIGHT + 4,
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
    // One fixed square per icon, with the glyph centred inside it. The square is
    // what the row lays out against, so the label after it starts at the same x
    // on every row no matter which glyph is in the box or how wide it draws.
    focusConfigIcon: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        flexGrow: 0,
        flexShrink: 0,
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
    // A plain sheet of glass over the controls that are settled for this
    // session. It blocks the touch — including the SwiftUI hosts the native
    // menus mount, which nothing in React Native can disable — without tinting
    // what is underneath, and turns the press into a shake.
    pressBlocker: {
        ...StyleSheet.absoluteFillObject,
    },
    composerPressBlocker: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        // Stops at the action row's top edge so the row's own blocker can leave
        // the send button, which is now Stop, reachable. Absolute children
        // measure from the padding box, so the shell's bottom padding counts.
        bottom: MOBILE_COMPOSER_METRICS.actionRowHeight + MOBILE_COMPOSER_METRICS.shellPaddingBottom,
    },
    // Reads like the session status row above the chat composer: one pulsing
    // dot and one line saying what is happening now. Absolutely placed in the
    // gap above the composer so that showing it moves nothing on the screen.
    // Absolute children measure from the padding box, so the inset the composer
    // gets from `focusComposerArea` is restated here to reach the same bounds.
    startProgressRow: {
        position: 'absolute',
        left: 16,
        right: 16,
        top: -START_PROGRESS_ROW_HEIGHT,
        height: START_PROGRESS_ROW_HEIGHT,
        alignItems: 'center',
    },
    // Sits inside the composer's own width, then insets by the same 16 the
    // session status bar uses inside its composer, so both screens hold their
    // status line the same distance from the shell on either side.
    startProgressContent: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 16,
    },
    startProgressText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
    startProgressHint: {
        flexShrink: 0,
        marginLeft: 'auto',
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
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

function shakeOnce(value: SharedValue<number>) {
    value.value = withSequence(
        ...SHAKE_KEYFRAMES.map((offset) => withTiming(offset, { duration: 50 })),
    );
}

/**
 * One control that refuses its own presses while a session is being created.
 *
 * The refusal is per control rather than per region so only the thing actually
 * touched shakes: the answer is about what was pressed. The blocker is a plain
 * transparent sheet because a native menu mounts a SwiftUI host that no React
 * Native `disabled` prop can reach, and it is a later sibling so it paints and
 * hits over the control it covers.
 */
function RefusableControl({
    refusing,
    onRefuse,
    children,
}: {
    refusing: boolean;
    onRefuse: () => void;
    children: React.ReactNode;
}) {
    const shake = useSharedValue(0);
    const shakeStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: shake.value }],
    }));
    return (
        <Animated.View style={shakeStyle}>
            {children}
            {refusing && (
                <Pressable
                    style={styles.pressBlocker}
                    onPress={() => {
                        shakeOnce(shake);
                        onRefuse();
                    }}
                />
            )}
        </Animated.View>
    );
}

/**
 * One picker row, which also does its own refusing while a session is starting.
 *
 * The refusal reuses the row's own animated view rather than wrapping it, so
 * nothing is added to the tree and the row's layout is untouched either way.
 */
function FocusConfigRevealRow({
    progress,
    index,
    refusing,
    onRefuse,
    children,
}: {
    progress: SharedValue<number>;
    index: number;
    refusing?: boolean;
    onRefuse?: () => void;
    children: React.ReactNode;
}) {
    const shake = useSharedValue(0);
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
            transform: [
                { translateY: 10 * (1 - reveal) },
                { translateX: shake.value },
            ],
        };
    }, [index]);

    return (
        <Animated.View style={[styles.focusConfigRevealRow, revealStyle]}>
            {children}
            {refusing && (
                <Pressable
                    style={styles.pressBlocker}
                    onPress={() => {
                        shakeOnce(shake);
                        onRefuse?.();
                    }}
                />
            )}
        </Animated.View>
    );
}

export const HomeDock = React.memo(({
    prompt,
    onPromptChange,
    onSubmit,
    isSubmitting,
    submitPhase,
    onSubmitCancel,
    showBottomBackdrop = true,
}: {
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => Promise<boolean>;
    isSubmitting: boolean;
    /** Which step of session creation is running, shown above the composer. */
    submitPhase?: NewSessionStartPhase | null;
    /** Stops session creation, the way the session composer stops the agent. */
    onSubmitCancel?: () => void;
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
    const renameMachineId = useNewSessionDraft((state) => state.renameMachineId);
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
    // A person picks a computer, not a daemon. Happy CLI and Happy Agent each register a machine
    // for the same laptop, so the pair is offered once and the agent settles which one runs.
    const machineChoices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const selectedChoice = React.useMemo(
        () => findMachineChoice(machineChoices, selectedMachineId),
        [machineChoices, selectedMachineId],
    );
    const machineOptions = React.useMemo<ModeOption[]>(() => (
        [...machineChoices]
            .sort((left, right) => Number(right.online) - Number(left.online))
            .map((choice) => ({
                key: choice.id,
                name: choice.name,
                description: choice.online
                    ? t('status.online')
                    : t('status.lastSeen', { time: formatLastSeen(choice.activeAt, false) }),
            }))
    ), [machineChoices]);
    const currentMachine = resolveOption(machineOptions, [selectedChoice?.id]);
    // A draft made before the pair was coalesced may still name Happy Agent's own machine, so the
    // selection is rewritten to the computer it belongs to rather than reset to the first one.
    const resolvedMachineId = resolveHomeDockMachineSelection(
        selectedChoice?.id ?? selectedMachineId,
        machineOptions.map((machine) => machine.key),
    );
    const selectedHomeDir = selectedChoice?.happyMachine?.metadata?.homeDir
        ?? selectedChoice?.rigMachine?.metadata?.homeDir;

    React.useEffect(() => {
        if (resolvedMachineId !== selectedMachineId) {
            renameMachineId(resolvedMachineId);
        }
    }, [resolvedMachineId, selectedMachineId, renameMachineId]);

    // The places on this computer belong to the pair rather than to whichever daemon opened them
    // first, so both machines are read for directories and for the catalogs they publish.
    const placeMachineIds = React.useMemo(
        () => selectedChoice?.machineIds ?? [],
        [selectedChoice],
    );
    const sessionList = React.useMemo<Session[]>(
        () => (sessions ?? []).filter((item): item is Session => typeof item !== 'string'),
        [sessions],
    );
    const places = React.useMemo(
        () => collectSessionPlaces({
            machineIds: placeMachineIds,
            selectedPath: selectedPath ?? '~',
            sessions: sessionList,
        }),
        [placeMachineIds, selectedPath, sessionList],
    );
    const projectOptions = React.useMemo<ModeOption[]>(() => {
        const homeDir = selectedHomeDir;
        return places.map((place) => {
            const relative = formatPathRelativeToHome(place.path, homeDir);
            // A project names itself; a bare directory is named by where it is.
            const name = place.projectId ? place.name : relative;
            return {
                key: place.key,
                name,
                description: name === place.path ? undefined : relative,
            };
        });
    }, [places, selectedHomeDir]);
    const selectedProjectId = React.useMemo(
        () => places.find((place) => place.path === selectedPath)?.projectId ?? null,
        [places, selectedPath],
    );
    const currentProject = resolveOption(projectOptions, [selectedPath, '~']);
    // Happy Agent's half of this computer, and only this computer's: a session asked for here is
    // never handed to a daemon somewhere else because that one happened to be reachable.
    const rigSelectionMachine = selectedChoice?.rigMachine ?? null;
    const rigSelectionCreation = React.useMemo(
        () => getRigMachineSessionCreation(rigSelectionMachine?.metadata),
        [rigSelectionMachine],
    );
    const rigCreation = agentType === 'rig' ? rigSelectionCreation : null;
    const happyCliVersion = selectedChoice?.happyMachine?.metadata?.happyCliVersion;
    const supportsWorktree = rigCreation?.supportsWorktrees
        ?? (agentType === 'rig' ? false : getSupportsWorktree(agentType));
    const selectedWorktreeKey = sessionType === 'worktree'
        ? worktreeKey ?? '__new__'
        : '__none__';
    const [existingWorktrees, setExistingWorktrees] = React.useState<ModeOption[]>([]);
    const agentWorkspaces = React.useMemo(
        () => collectSessionWorkspaces({
            machineIds: placeMachineIds,
            projectId: selectedProjectId,
            sessions: sessionList,
        }),
        [placeMachineIds, selectedProjectId, sessionList],
    );

    React.useEffect(() => {
        const path = resolveAbsolutePath(selectedPath ?? '~', selectedHomeDir);

        // A Happy Agent project keeps its own workspaces, each with a name somebody chose. Those
        // are better than the branches git reports, so git is only asked when nothing knows better.
        // Starting in one only needs its directory, so this does not wait on the worktree
        // capability the daemon advertises for making new ones.
        if (selectedProjectId) {
            setExistingWorktrees(agentWorkspaces.map((workspace) => ({
                key: workspace.key,
                name: workspace.name,
                description: workspace.path,
            })));
            return;
        }

        // Only Happy CLI's daemon answers the worktree RPC, so it is asked directly rather than
        // through whichever machine the draft happens to name.
        const happyMachine = selectedChoice?.happyMachine ?? null;
        if (!supportsWorktree || !happyMachine || !isMachineOnline(happyMachine) || !path) {
            setExistingWorktrees([]);
            return;
        }

        let cancelled = false;
        listWorktrees(happyMachine.id, path).then((worktrees) => {
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
    }, [agentWorkspaces, selectedChoice, selectedHomeDir, selectedPath, selectedProjectId, supportsWorktree]);

    // Happy Agent calls these workspaces, and names them; git calls them worktrees.
    const picksWorkspaces = selectedProjectId !== null;
    const createsNativeHappyAgentWorkspace = agentType === 'rig'
        && picksWorkspaces
        && rigCreation !== null;
    const worktreeCreationMachine = React.useMemo(
        () => resolveWorktreeCreationMachine(selectedChoice, agentType, supportsWorktree),
        [agentType, selectedChoice, supportsWorktree],
    );
    // Happy Agent owns workspace creation through its catalog-native spawn.
    // Happy CLI's Git RPC remains only for the ordinary code-agent worktree flow.
    const canCreateWorktree = createsNativeHappyAgentWorkspace
        || (agentType !== 'rig' && worktreeCreationMachine !== null);

    React.useEffect(() => {
        if (!supportsWorktree && !picksWorkspaces && sessionType === 'worktree') {
            setSessionType('simple');
            setWorktreeKey(null);
        }
    }, [picksWorkspaces, sessionType, setSessionType, setWorktreeKey, supportsWorktree]);

    const worktreeOptions = React.useMemo<ModeOption[]>(() => {
        if (!supportsWorktree && !picksWorkspaces) {
            return [{
                key: '__none__',
                name: 'No worktree',
                description: `Not supported by ${getHarnessName(agentType)}`,
            }];
        }
        const options: ModeOption[] = [
            ...(canCreateWorktree
                ? [{ key: '__new__', name: picksWorkspaces ? 'Create New' : 'Create new worktree' }]
                : []),
            // Starting in no workspace means starting in the project's own
            // checkout, which is a place with a name rather than an absence.
            { key: '__none__', name: picksWorkspaces ? 'Main' : 'No worktree' },
            ...existingWorktrees,
        ];
        if (
            worktreeKey
            && !options.some((option) => option.key === worktreeKey)
        ) {
            options.push({ key: worktreeKey, name: worktreeKey });
        }
        return options;
    }, [agentType, canCreateWorktree, existingWorktrees, picksWorkspaces, supportsWorktree, worktreeKey]);
    const currentWorktree = resolveOption(worktreeOptions, [selectedWorktreeKey]);
    // Common harnesses stay listed but disabled when unavailable, so the picker
    // still reads as a choice. Antigravity is niche and stays entirely absent
    // until this computer explicitly reports it installed.
    const harnessKeys = React.useMemo<NewSessionAgentType[]>(() => (
        (HARNESS_ORDER.includes(agentType) ? [...HARNESS_ORDER] : [agentType, ...HARNESS_ORDER])
            .filter((key) => machineChoiceAgentVisible(selectedChoice, key))
    ), [agentType, selectedChoice]);
    const availableAgents = React.useMemo<ModeOption[]>(() => (
        harnessKeys.map((key) => {
            const agent = { key, name: getHarnessName(key) };
            return machineChoiceAgentAvailable(selectedChoice, key)
                ? agent
                : {
                    ...agent,
                    disabled: true,
                    description: key === 'rig'
                        ? 'Happy Agent is not running on this computer'
                        : 'Not installed on this machine',
                };
        })
    ), [harnessKeys, selectedChoice]);
    const resolvedAgentType = resolveChoiceAgent(selectedChoice, agentType);
    const defaults = React.useMemo(() => rigCreation
        ? {
            permissionMode: rigCreation.defaultPermissionMode ?? '',
            modelMode: rigCreation.defaultModelKey ?? '',
            effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
        }
        : resolveAgentDefaultConfig(defaultOverrides, agentType, happyCliVersion), [agentType, defaultOverrides, happyCliVersion, rigCreation]);
    const permissionOptions = React.useMemo(
        // The CLI daemon on the picked computer is what will parse the mode;
        // older CLIs drop the whole prompt on modes they do not know (`auto`).
        () => rigCreation?.permissionModes ?? filterPermissionModesForCli(
            getHardcodedPermissionModes(agentType, t),
            happyCliVersion,
        ),
        [agentType, happyCliVersion, rigCreation],
    );
    const modelOptions = React.useMemo(
        () => rigCreation?.models ?? includeConfiguredModel(
            agentType,
            getHardcodedModelModes(agentType, t),
            defaults.modelMode,
        ),
        [agentType, defaults.modelMode, rigCreation],
    );
    // The code default last: when the saved and configured modes were both
    // filtered out for an old CLI, land there rather than on whichever mode
    // happens to lead the list.
    const currentPermission = resolveOption(permissionOptions, [
        permissionMode,
        defaults.permissionMode,
        rigCreation ? null : getCodeAgentDefaults(agentType, happyCliVersion).permissionMode,
    ]);
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
    const currentAgent = availableAgents.find((agent) => agent.key === agentType)
        ?? availableAgents[0]
        ?? { key: agentType, name: getHarnessName(agentType) };
    const permissionLabel = getPermissionModeShortLabel(currentPermission);
    const focusedPromptPlaceholder = resolveHomeDockPromptPlaceholder(currentAgent.key, currentAgent.name);
    const canSubmit = !isSubmitting && (
        prompt.trim().length > 0 || selectedImages.length > 0
    );
    const startPhase = isSubmitting ? submitPhase ?? 'spawning' : null;
    const startProgressLabel = resolveNewSessionProgressLabel({
        phase: startPhase,
        agentName: currentAgent.name,
        picksWorkspaces,
    });
    const primaryAction = resolveNewSessionPrimaryAction({
        canSubmit,
        phase: startPhase,
        canCancel: !!onSubmitCancel,
    });
    const primaryActionFilled = primaryAction === 'send' || primaryAction === 'stop';
    const primaryActionIconColor = theme.dark ? '#111111' : theme.colors.button.primary.tint;
    const composerShakerRef = React.useRef<ShakeInstance>(null);
    // Anything refused points at the way out: the hint and the Stop button both
    // flash, so the answer to "this is blocked" is "here is the thing that
    // isn't". Two beats rather than one — a single fade is easy to miss on a
    // button that is already solid black.
    const refusalFlash = useSharedValue(0);
    const refuse = React.useCallback(() => {
        hapticsError();
        refusalFlash.value = withSequence(
            withTiming(1, { duration: 90 }),
            withTiming(0, { duration: 130 }),
            withTiming(1, { duration: 90 }),
            withTiming(0, { duration: 340 }),
        );
    }, [refusalFlash]);
    const refuseWithShake = React.useCallback((shaker: React.RefObject<ShakeInstance | null>) => {
        refuse();
        shaker.current?.shake();
    }, [refuse]);
    const startProgressHintStyle = useAnimatedStyle(() => ({
        color: interpolateColor(
            refusalFlash.value,
            [0, 1],
            [theme.colors.textSecondary, theme.colors.text],
        ),
    }));
    const primaryActionFlashStyle = useAnimatedStyle(() => ({
        transform: [{ scale: 1 + refusalFlash.value * 0.1 }],
    }));
    // The button is already the darkest thing on screen, so its flash is the
    // inverse of the hint's: a lighter wash over the fill, drawn under the glyph
    // so the glyph stays readable through it. Painting over the fill rather than
    // animating it keeps BubblePressable's own press scale untouched.
    const primaryActionFlashOverlayStyle = useAnimatedStyle(() => ({
        opacity: refusalFlash.value * 0.55,
    }));
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
    }, []);

    const handleFocusModeRequestClose = React.useCallback(() => {
        const action = resolveHomeDockPickerBackAction({
            hasPage: sheetPage !== null,
            starting: isSubmitting,
        });
        if (action === 'refuse') {
            refuse();
            return;
        }
        if (action === 'close-picker') {
            closePicker();
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, closePicker, isSubmitting, refuse, sheetPage]);

    const selectAgent = React.useCallback((agent: NewSessionAgentType) => {
        const nextRigCreation = agent === 'rig' ? rigSelectionCreation : null;
        const nextDefaults = nextRigCreation
            ? {
                permissionMode: nextRigCreation.defaultPermissionMode ?? '',
                modelMode: nextRigCreation.defaultModelKey ?? '',
                effortLevel: nextRigCreation.defaultEffortForModel(nextRigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agent, happyCliVersion);
        // Choosing Happy Agent no longer moves the machine selection: the computer already covers
        // both daemons, and switching it under the person was what made the picker show two.
        setAgentType(agent);
        setPermissionMode(nextDefaults.permissionMode);
        setModelMode(nextDefaults.modelMode);
        if (nextDefaults.effortLevel) setEffortLevel(nextDefaults.effortLevel);
    }, [defaultOverrides, happyCliVersion, rigSelectionCreation, setAgentType, setEffortLevel, setModelMode, setPermissionMode]);

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

    // The rows stacked above the focused composer. The harness sits with
    // machine/project/worktree because all four say where and with what the
    // session runs, and all four are settled before anything is typed.
    const environmentRows: SettingsRow[] = [
        { page: 'machine', label: 'MACHINE', value: currentMachine?.name ?? 'Select machine', icon: 'desktop-outline' },
        { page: 'project', label: 'PROJECT', value: currentProject?.name ?? '~', icon: 'folder-outline' },
        {
            page: 'worktree',
            label: picksWorkspaces ? 'WORKSPACE' : 'WORKTREE',
            value: currentWorktree?.name ?? (picksWorkspaces ? 'Main' : 'No worktree'),
            icon: 'git-branch-outline',
        },
        { page: 'agent', label: 'HARNESS', value: currentAgent.name, icon: 'hardware-chip-outline' },
    ];
    const agentRows: SettingsRow[] = [
        ...(currentModel ? [{ page: 'model', label: t('agentInput.model.title'), value: currentModel.name, icon: 'cube-outline' as const }] : []),
        ...(currentPermission ? [{ page: 'permission', label: t('agentInput.permissionMode.title'), value: permissionLabel ?? currentPermission.name, icon: 'shield-outline' as const }] : []),
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
            title: picksWorkspaces ? 'Workspace' : 'Worktree',
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
            return { title: 'Harness', options: availableAgents, selectedKey: agentType, onSelect: (key) => selectAgent(key as NewSessionAgentType) };
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
                // The permission menu spells the mode out; only its chip is
                // short on space. Model and effort read fine on their own.
                label: row.page === 'permission' ? getPermissionModeMenuLabel(option) : option.name,
                disabled: option.disabled,
            })),
            selectedKey: config.selectedKey,
            onSelect: config.onSelect,
        };
    });
    const modelSettingsGroup = agentSettingsGroups.find((group) => group.key === 'model');
    const effortSettingsGroup = agentSettingsGroups.find((group) => group.key === 'effort');
    const permissionSettingsGroup = agentSettingsGroups.find((group) => group.key === 'permission');

    const getPickerConfig = (page: PickerPage): PickerConfig => (
        page === 'machine' || page === 'project' || page === 'worktree'
            ? getEnvironmentPickerConfig(page)
            : getAgentPickerConfig(page)
    );
    const sheetVisible = !useNativeMenus && sheetPage !== null;
    const markNativeMenuOpen = React.useCallback(() => {
        nativeMenuOpenRef.current = true;
    }, []);
    const handleFocusBackdropPress = React.useCallback(() => {
        const action = resolveHomeDockBackdropPressAction({
            nativeMenuOpen: useNativeMenus && nativeMenuOpenRef.current,
            pickerVisible: sheetVisible,
            starting: isSubmitting,
        });
        nativeMenuOpenRef.current = false;
        if (action === 'dismiss-menu') {
            return;
        }
        if (action === 'refuse') {
            refuse();
            return;
        }
        if (action === 'close-picker') {
            closePicker();
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, closePicker, isSubmitting, refuse, sheetVisible, useNativeMenus]);

    // Stop is about this screen, not about the machine. It gives the composer
    // back immediately and lets the kill run unwatched, because a Stop that
    // waits on the thing that is already not answering is not a way out.
    const handleStopPress = React.useCallback(() => {
        onSubmitCancel?.();
        closeFocusMode();
    }, [closeFocusMode, onSubmitCancel]);

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
                    onPress={() => setSheetPage(row.page as PickerPage)}
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
            refusing={isSubmitting}
            onRefuse={refuse}
        >
            {renderPickerRow(row, getPickerConfig(row.page as PickerPage), true)}
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
        page: PickerPage;
        groups: NativeSettingsMenuGroup[];
        flat?: boolean;
        style: NativeSettingsMenuProps['style'];
        accessibilityLabel: string;
        triggerSystemImage?: NativeSettingsMenuProps['triggerSystemImage'];
        triggerLabel?: NativeSettingsMenuProps['triggerLabel'];
        triggerAlignment?: NativeSettingsMenuProps['triggerAlignment'];
        children: React.ReactNode;
    }) => (
        <RefusableControl refusing={isSubmitting} onRefuse={refuse}>
            {!useNativeMenus ? (
                <Pressable
                    onPress={() => setSheetPage(page)}
                    style={style}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                >
                    {children}
                </Pressable>
            ) : (
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
            )}
        </RefusableControl>
    );

    // Only reached with a page selected: `sheetVisible` gates the whole sheet.
    const renderSettingsSheet = (page: PickerPage) => {
        const config = getPickerConfig(page);
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
                            onPress={closePicker}
                            style={styles.backButton}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                        >
                            <Ionicons name="close" size={20} color={theme.colors.text} />
                        </Pressable>
                        <Text style={styles.settingsTitle} numberOfLines={1}>
                            {config.title}
                        </Text>
                    </View>
                    <ScrollView style={styles.optionList} keyboardShouldPersistTaps="always">
                        {config.options.map((option) => {
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
                        })}
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
        useNewSessionDraft.getState().setAttachments(selectedImages);
        const started = await onSubmit();
        if (started) clearImages();
        return started;
    };

    // The dock, the keyboard, and the scrim all stay put until the session
    // exists. Closing first left the session list with a spinner nowhere near
    // the composer, and a failure landed on a screen that had already moved on.
    const submitFromFocusMode = () => {
        if (!canSubmit) return;
        closePicker();
        void (async () => {
            const started = await submit();
            if (started) closeFocusMode();
        })();
    };

    const renderFocusedComposer = () => (
        <Shaker ref={composerShakerRef} style={styles.focusedComposerShadow}>
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
                    {selectedImages.length > 0 && (
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
                            // `editable={false}` would take the keyboard down
                            // with it, and the keyboard is the thing this whole
                            // flow keeps up. The input is controlled, so
                            // refusing the change is what locks it: the value
                            // never moves off the prompt being sent.
                            onChangeText={(next) => {
                                if (isSubmitting) {
                                    refuseWithShake(composerShakerRef);
                                    return;
                                }
                                onPromptChange(next);
                            }}
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
                    {/* Painted over the attachments and the input, and stopping
                        short of the action row. The controls keep their normal
                        appearance; only the touch is refused. */}
                    {isSubmitting && (
                        <Pressable
                            style={styles.composerPressBlocker}
                            onPress={() => refuseWithShake(composerShakerRef)}
                        />
                    )}
                    <Animated.View style={[styles.focusedComposerActions, focusedActionsRevealStyle]}>
                        <RefusableControl refusing={isSubmitting} onRefuse={refuse}>
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
                        </RefusableControl>
                        {/* The permission mode reads out in words instead of
                            hiding behind a gear: it is the one setting here that
                            changes what the agent is allowed to do to your
                            machine, so it is worth the width. */}
                        {permissionSettingsGroup && permissionLabel && renderMenuControl({
                            page: 'permission',
                            groups: [permissionSettingsGroup],
                            flat: true,
                            style: styles.nativePermissionMenu,
                            accessibilityLabel: t('agentInput.permissionMode.title'),
                            triggerLabel: permissionLabel,
                            // Centered to agree with the React Native chip this
                            // stands in for on iOS: the frame is sized by that
                            // chip, so a leading trigger would print the word
                            // flush left while the chip reserves padding.
                            triggerAlignment: 'center',
                            children: (
                                <View style={styles.focusedPermissionButton}>
                                    <Text style={styles.focusedModeText} numberOfLines={1}>
                                        {permissionLabel}
                                    </Text>
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
                        {/* Nothing covers this row as a whole: each control
                            beside Stop refuses its own presses, which leaves
                            Stop itself reachable without having to be painted
                            over a blocker. */}
                        {/* One button, read the same way as the session
                            composer's: it sends, and while the session is being
                            created it stops. */}
                        <Animated.View style={primaryActionFlashStyle}>
                            <BubblePressable
                                onPress={primaryAction === 'stop' ? handleStopPress : submitFromFocusMode}
                                disabled={primaryAction !== 'send' && primaryAction !== 'stop'}
                                style={[styles.sendButton, primaryActionFilled && styles.sendButtonActive]}
                                accessibilityRole="button"
                                accessibilityLabel={primaryAction === 'stop' ? 'Stop' : 'Send'}
                            >
                                {primaryAction === 'stop' && (
                                    <Animated.View
                                        pointerEvents="none"
                                        style={[styles.primaryActionFlash, primaryActionFlashOverlayStyle]}
                                    />
                                )}
                                {primaryAction === 'busy' ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : primaryAction === 'stop' ? (
                                    <Octicons name="stop" size={16} color={primaryActionIconColor} />
                                ) : (
                                    <Ionicons
                                        name="arrow-up"
                                        size={16}
                                        color={primaryAction === 'send'
                                            ? primaryActionIconColor
                                            : theme.colors.textSecondary}
                                    />
                                )}
                            </BubblePressable>
                        </Animated.View>
                    </Animated.View>
                </View>
                </MobileGlassSurface>
            </Animated.View>
        </Shaker>
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
                        style={[styles.modalBackdrop, focusBackdropStyle]}
                    >
                        <BlurView
                            blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                            blurReductionFactor={2}
                            intensity={8}
                            pointerEvents="none"
                            tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                            style={styles.modalBackdrop}
                        />
                        <View
                            pointerEvents="none"
                            style={[styles.modalBackdrop, styles.focusBackdropDim]}
                        />
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
                            {sheetVisible && sheetPage ? renderSettingsSheet(sheetPage) : (
                                <View style={styles.focusConfigGroup}>
                                    {renderEnvironmentPickers()}
                                </View>
                            )}
                            {/* The sheet is a single surface rather than a row
                                of controls, so its refusal is the whole sheet. */}
                            {isSubmitting && sheetVisible && sheetPage && (
                                <Pressable style={styles.pressBlocker} onPress={refuse} />
                            )}
                        </View>
                        <View style={[
                            styles.focusComposerArea,
                            { paddingBottom: safeArea.bottom + 8 },
                        ]}>
                            {/* Absolutely placed in the gap the dock already
                                leaves, so it appears without moving anything. */}
                            {startProgressLabel && (
                                <View pointerEvents="none" style={styles.startProgressRow}>
                                    <View style={styles.startProgressContent}>
                                        <StatusDot color={theme.colors.status.connecting} isPulsing size={6} />
                                        <Text style={styles.startProgressText} numberOfLines={1}>
                                            {startProgressLabel}
                                        </Text>
                                        {primaryAction === 'stop' && (
                                            <Animated.Text
                                                style={[styles.startProgressHint, startProgressHintStyle]}
                                                numberOfLines={1}
                                            >
                                                To interrupt press stop
                                            </Animated.Text>
                                        )}
                                    </View>
                                </View>
                            )}
                            {renderFocusedComposer()}
                        </View>
                    </Animated.View>
                </View>
            </RNModal>

        </>
    );
});
