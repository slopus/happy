import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, Image as RNImage, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { normalizePermissionModeForAgentFlavor, type PermissionMode, type ModelMode } from '@/sync/permissionTypes';
import { getModelOptionsForAgentType } from '@/sync/modelOptions';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { FloatingOverlay } from './FloatingOverlay';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile } from '@/sync/profileUtils';

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onPermissionClick?: () => void;
    modelMode?: ModelMode;
    onModelModeChange?: (mode: ModelMode) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
        cliStatus?: {
            claude: boolean | null;
            codex: boolean | null;
            gemini?: boolean | null;
        };
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex' | 'gemini';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    profileId?: string | null;
    onProfileClick?: () => void;
    envVarsCount?: number;
    onEnvVarsClick?: () => void;
    contentPaddingHorizontal?: number;
    panelStyle?: ViewStyle;
}

const MAX_CONTEXT_SIZE = 190000;

function truncateWithEllipsis(value: string, maxChars: number) {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…`;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: 8,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    settingsOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    overlayBackdrop: {
        position: 'absolute',
        top: -1000,
        left: -1000,
        right: -1000,
        bottom: -1000,
        zIndex: 999,
    },
    overlaySection: {
        paddingVertical: 8,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    overlayDivider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 16,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusText: {
        fontSize: 11,
        ...Typography.default(),
    },
    statusDot: {
        marginRight: 6,
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },
    contextWarningText: {
        fontSize: 11,
        marginLeft: 8,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsColumn: {
        flexDirection: 'column',
        flex: 1,
        gap: 3,
    },
    actionButtonsColumnNarrow: {
        flexDirection: 'column',
        flex: 1,
        gap: 2,
    },
    actionButtonsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    pathRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        columnGap: 6,
        rowGap: 3,
        flex: 1,
        flexWrap: 'wrap',
        overflow: 'visible',
    },
    actionButtonsLeftNarrow: {
        columnGap: 4,
    },
    actionButtonsLeftNoFlex: {
        flex: 0,
    },
    actionChip: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 10,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
        gap: 6,
    },
    actionChipPressed: {
        opacity: 0.7,
    },
    actionChipText: {
        fontSize: 13,
        color: theme.colors.button.secondary.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    overlayOptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    overlayOptionRowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    overlayRadioOuter: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    overlayRadioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    overlayRadioOuterUnselected: {
        borderColor: theme.colors.radio.inactive,
    },
    overlayRadioInner: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    overlayOptionLabel: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    overlayOptionLabelSelected: {
        color: theme.colors.radio.active,
    },
    overlayOptionLabelUnselected: {
        color: theme.colors.text,
    },
    overlayOptionDescription: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    overlayEmptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        ...Typography.default(),
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
        marginRight: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
    micIcon: {
        width: 24,
        height: 24,
    },
}));

const getContextWarning = (contextSize: number, alwaysShow: boolean = false, theme: Theme) => {
    const percentageUsed = (contextSize / MAX_CONTEXT_SIZE) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null; // No display needed
};

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const screenWidth = useWindowDimensions().width;

    const hasText = props.value.trim().length > 0;

    // Check if this is a Codex or Gemini session
    const effectiveFlavor = props.metadata?.flavor ?? props.agentType;
    const isCodex = effectiveFlavor === 'codex';
    const isGemini = effectiveFlavor === 'gemini';
    const modelOptions = React.useMemo(() => {
        if (effectiveFlavor === 'claude' || effectiveFlavor === 'codex' || effectiveFlavor === 'gemini') {
            return getModelOptionsForAgentType(effectiveFlavor);
        }
        return [];
    }, [effectiveFlavor]);

    // Profile data
    const profiles = useSetting('profiles');
    const currentProfile = React.useMemo(() => {
        if (props.profileId === undefined || props.profileId === null || props.profileId.trim() === '') {
            return null;
        }
        // Check custom profiles first
        const customProfile = profiles.find(p => p.id === props.profileId);
        if (customProfile) return customProfile;
        // Check built-in profiles
        return getBuiltInProfile(props.profileId);
    }, [profiles, props.profileId]);

	    const profileLabel = React.useMemo(() => {
	        if (props.profileId === undefined) {
	            return null;
	        }
	        if (props.profileId === null || props.profileId.trim() === '') {
	            return t('profiles.noProfile');
	        }
        if (currentProfile) {
            return currentProfile.name;
        }
        const shortId = props.profileId.length > 8 ? `${props.profileId.slice(0, 8)}…` : props.profileId;
        return `${t('status.unknown')} (${shortId})`;
	    }, [props.profileId, currentProfile]);

		    const profileIcon = React.useMemo(() => {
		        // Always show a stable "profile" icon so the chip reads as Profile selection (not "current provider").
		        return 'person-circle-outline';
		    }, []);

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, props.alwaysShowContextSize ?? false, theme)
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        setInputState(newState);
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Settings modal state
    const [showSettings, setShowSettings] = React.useState(false);

    const normalizedPermissionMode = React.useMemo(() => {
        return normalizePermissionModeForAgentFlavor(
            props.permissionMode ?? 'default',
            isCodex ? 'codex' : isGemini ? 'gemini' : 'claude',
        );
    }, [isCodex, isGemini, props.permissionMode]);

    const permissionChipLabel = React.useMemo(() => {
        if (isCodex) {
            return normalizedPermissionMode === 'default'
                ? t('agentInput.codexPermissionMode.default')
                : normalizedPermissionMode === 'read-only'
                    ? t('agentInput.codexPermissionMode.readOnly')
                    : normalizedPermissionMode === 'safe-yolo'
                        ? t('agentInput.codexPermissionMode.safeYolo')
                        : normalizedPermissionMode === 'yolo'
                            ? t('agentInput.codexPermissionMode.yolo')
                            : '';
        }

        if (isGemini) {
            return normalizedPermissionMode === 'default'
                ? t('agentInput.geminiPermissionMode.default')
                : normalizedPermissionMode === 'read-only'
                    ? t('agentInput.geminiPermissionMode.readOnly')
                    : normalizedPermissionMode === 'safe-yolo'
                        ? t('agentInput.geminiPermissionMode.safeYolo')
                        : normalizedPermissionMode === 'yolo'
                            ? t('agentInput.geminiPermissionMode.yolo')
                            : '';
        }

        return normalizedPermissionMode === 'default'
            ? t('agentInput.permissionMode.default')
            : normalizedPermissionMode === 'acceptEdits'
                ? t('agentInput.permissionMode.acceptEdits')
                : normalizedPermissionMode === 'plan'
                    ? t('agentInput.permissionMode.plan')
                    : normalizedPermissionMode === 'bypassPermissions'
                        ? t('agentInput.permissionMode.bypassPermissions')
                        : '';
    }, [isCodex, isGemini, normalizedPermissionMode]);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => !prev);
    }, []);

    const showPermissionChip = Boolean(props.onPermissionModeChange || props.onPermissionClick);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        // Don't close the settings overlay - let users see the change and potentially switch again
    }, [props.onPermissionModeChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey) {
                if (props.value.trim()) {
                    props.onSend();
                    return true; // Key was handled
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange) {
                const modeOrder: PermissionMode[] = isCodex
                    ? ['default', 'read-only', 'safe-yolo', 'yolo']
                    : isGemini
                        ? ['default', 'read-only', 'safe-yolo', 'yolo']
                        : ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
                const currentIndex = modeOrder.indexOf(props.permissionMode || 'default');
                const nextIndex = (currentIndex + 1) % modeOrder.length;
                props.onPermissionModeChange(modeOrder[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.value, props.onSend, props.permissionMode, props.onPermissionModeChange, isCodex, isGemini]);




    return (
        <View style={[
            styles.container,
            { paddingHorizontal: props.contentPaddingHorizontal ?? (screenWidth > 700 ? 16 : 8) }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={[
                        styles.autocompleteOverlay,
                        { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                    ]}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {/* Settings overlay */}
                {showSettings && (
                    <>
                        <Pressable onPress={() => setShowSettings(false)} style={styles.overlayBackdrop} />
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                        ]}>
                            <FloatingOverlay maxHeight={400} keyboardShouldPersistTaps="always">
                                {/* Permission Mode Section */}
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {isCodex ? t('agentInput.codexPermissionMode.title') : isGemini ? t('agentInput.geminiPermissionMode.title') : t('agentInput.permissionMode.title')}
                                    </Text>
                                    {((isCodex || isGemini)
                                        ? (['default', 'read-only', 'safe-yolo', 'yolo'] as const)
                                        : (['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const)
                                    ).map((mode) => {
                                        const modeConfig = isCodex ? {
                                            'default': { label: t('agentInput.codexPermissionMode.default') },
                                            'read-only': { label: t('agentInput.codexPermissionMode.readOnly') },
                                            'safe-yolo': { label: t('agentInput.codexPermissionMode.safeYolo') },
                                            'yolo': { label: t('agentInput.codexPermissionMode.yolo') },
                                        } : isGemini ? {
                                            'default': { label: t('agentInput.geminiPermissionMode.default') },
                                            'read-only': { label: t('agentInput.geminiPermissionMode.readOnly') },
                                            'safe-yolo': { label: t('agentInput.geminiPermissionMode.safeYolo') },
                                            'yolo': { label: t('agentInput.geminiPermissionMode.yolo') },
                                        } : {
                                            default: { label: t('agentInput.permissionMode.default') },
                                            acceptEdits: { label: t('agentInput.permissionMode.acceptEdits') },
                                            plan: { label: t('agentInput.permissionMode.plan') },
                                            bypassPermissions: { label: t('agentInput.permissionMode.bypassPermissions') },
                                        };
                                        const config = modeConfig[mode as keyof typeof modeConfig];
                                        if (!config) return null;
                                        const isSelected = normalizedPermissionMode === mode;

                                        return (
                                            <Pressable
                                                key={mode}
                                                onPress={() => handleSettingsSelect(mode)}
                                                style={({ pressed }) => [
                                                    styles.overlayOptionRow,
                                                    pressed ? styles.overlayOptionRowPressed : null,
                                                ]}
                                            >
                                                <View
                                                    style={[
                                                        styles.overlayRadioOuter,
                                                        isSelected
                                                            ? styles.overlayRadioOuterSelected
                                                            : styles.overlayRadioOuterUnselected,
                                                    ]}
                                                >
                                                    {isSelected && (
                                                        <View style={styles.overlayRadioInner} />
                                                    )}
                                                </View>
                                                <Text
                                                    style={[
                                                        styles.overlayOptionLabel,
                                                        isSelected ? styles.overlayOptionLabelSelected : styles.overlayOptionLabelUnselected,
                                                    ]}
                                                >
                                                    {config.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                {/* Divider */}
                                <View style={styles.overlayDivider} />

                                {/* Model Section */}
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {t('agentInput.model.title')}
                                    </Text>
                                    {modelOptions.length > 0 ? (
                                        modelOptions.map((option) => {
                                            const isSelected = props.modelMode === option.value;
                                            return (
                                                <Pressable
                                                    key={option.value}
                                                    onPress={() => {
                                                        hapticsLight();
                                                        props.onModelModeChange?.(option.value);
                                                    }}
                                                    style={({ pressed }) => [
                                                        styles.overlayOptionRow,
                                                        pressed ? styles.overlayOptionRowPressed : null,
                                                    ]}
                                                >
                                                    <View
                                                        style={[
                                                            styles.overlayRadioOuter,
                                                            isSelected
                                                                ? styles.overlayRadioOuterSelected
                                                                : styles.overlayRadioOuterUnselected,
                                                        ]}
                                                    >
                                                        {isSelected && (
                                                            <View style={styles.overlayRadioInner} />
                                                        )}
                                                    </View>
                                                    <View>
                                                        <Text
                                                            style={[
                                                                styles.overlayOptionLabel,
                                                                isSelected
                                                                    ? styles.overlayOptionLabelSelected
                                                                    : styles.overlayOptionLabelUnselected,
                                                            ]}
                                                        >
                                                            {option.label}
                                                        </Text>
                                                        <Text style={styles.overlayOptionDescription}>
                                                            {option.description}
                                                        </Text>
                                                    </View>
                                                </Pressable>
                                            );
                                        })
                                    ) : (
                                        <Text style={styles.overlayEmptyText}>
                                            {t('agentInput.model.configureInCli')}
                                        </Text>
                                    )}
                                </View>
                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Connection status, context warning, and permission mode */}
                {(props.connectionStatus || contextWarning) && (
                    <View style={styles.statusContainer}>
                        <View style={styles.statusRow}>
                            {props.connectionStatus && (
                                <>
                                    <StatusDot
                                        color={props.connectionStatus.dotColor}
                                        isPulsing={props.connectionStatus.isPulsing}
                                        size={6}
                                        style={styles.statusDot}
                                    />
                                    <Text style={[styles.statusText, { color: props.connectionStatus.color }]}>
                                        {props.connectionStatus.text}
                                    </Text>
                                </>
                            )}
                            {contextWarning && (
                                <Text
                                    style={[
                                        styles.statusText,
                                        {
                                            color: contextWarning.color,
                                            marginLeft: props.connectionStatus ? 8 : 0,
                                        },
                                    ]}
                                >
                                    {props.connectionStatus ? '• ' : ''}{contextWarning.text}
                                </Text>
                            )}
                        </View>
                        <View style={styles.permissionModeContainer}>
                            {props.permissionMode && (
                                <Text
                                    style={[
                                        styles.permissionModeText,
                                        {
                                            color: normalizedPermissionMode === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                                normalizedPermissionMode === 'bypassPermissions' ? theme.colors.permission.bypass :
                                                    normalizedPermissionMode === 'plan' ? theme.colors.permission.plan :
                                                        normalizedPermissionMode === 'read-only' ? theme.colors.permission.readOnly :
                                                            normalizedPermissionMode === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                                normalizedPermissionMode === 'yolo' ? theme.colors.permission.yolo :
                                                                    theme.colors.textSecondary, // Use secondary text color for default
                                        },
                                    ]}
                                >
                                    {isCodex ? (
                                        normalizedPermissionMode === 'default' ? t('agentInput.codexPermissionMode.default') :
                                            normalizedPermissionMode === 'read-only' ? t('agentInput.codexPermissionMode.badgeReadOnly') :
                                                normalizedPermissionMode === 'safe-yolo' ? t('agentInput.codexPermissionMode.badgeSafeYolo') :
                                                    normalizedPermissionMode === 'yolo' ? t('agentInput.codexPermissionMode.badgeYolo') : ''
                                    ) : isGemini ? (
                                        normalizedPermissionMode === 'default' ? t('agentInput.geminiPermissionMode.default') :
                                            normalizedPermissionMode === 'read-only' ? t('agentInput.geminiPermissionMode.badgeReadOnly') :
                                                normalizedPermissionMode === 'safe-yolo' ? t('agentInput.geminiPermissionMode.badgeSafeYolo') :
                                                    normalizedPermissionMode === 'yolo' ? t('agentInput.geminiPermissionMode.badgeYolo') : ''
                                    ) : (
                                        normalizedPermissionMode === 'default' ? t('agentInput.permissionMode.default') :
                                            normalizedPermissionMode === 'acceptEdits' ? t('agentInput.permissionMode.badgeAcceptAllEdits') :
                                        normalizedPermissionMode === 'bypassPermissions' ? t('agentInput.permissionMode.badgeBypassAllPermissions') :
                                            normalizedPermissionMode === 'plan' ? t('agentInput.permissionMode.badgePlanMode') : ''
                                    )}
                                </Text>
                            )}
                        </View>
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={[styles.unifiedPanel, props.panelStyle]}>
                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={120}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={screenWidth < 420 ? styles.actionButtonsColumnNarrow : styles.actionButtonsColumn}>
                            {/* Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status */}
                            <View style={styles.actionButtonsRow}>
                                <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                    {/* Permission chip (popover in standard flow, scroll in wizard) */}
                                    {showPermissionChip && (
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                if (props.onPermissionClick) {
                                                    props.onPermissionClick();
                                                    return;
                                                }
                                                handleSettingsPress();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => [
                                                styles.actionChip,
                                                p.pressed ? styles.actionChipPressed : null,
                                            ]}
                                        >
                                            <Ionicons
                                                name="settings-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            <Text style={styles.actionChipText}>
                                                {permissionChipLabel}
                                            </Text>
                                        </Pressable>
                                    )}

                                    {/* Profile selector button - FIRST */}
                                    {props.onProfileClick && (
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                props.onProfileClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => [
                                                styles.actionChip,
                                                p.pressed ? styles.actionChipPressed : null,
                                            ]}
                                        >
                                            <Ionicons
                                                name={profileIcon as any}
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            <Text style={styles.actionChipText}>
                                                {profileLabel ?? t('profiles.noProfile')}
                                            </Text>
                                        </Pressable>
                                    )}

                                    {/* Env vars preview (standard flow) */}
                                    {props.onEnvVarsClick && (
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                props.onEnvVarsClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => [
                                                styles.actionChip,
                                                p.pressed ? styles.actionChipPressed : null,
                                            ]}
                                        >
                                            <Ionicons
                                                name="list-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            <Text style={styles.actionChipText}>
                                                {props.envVarsCount === undefined
                                                    ? t('agentInput.envVars.title')
                                                    : t('agentInput.envVars.titleWithCount', { count: props.envVarsCount })}
                                            </Text>
                                        </Pressable>
                                    )}

                                    {/* Agent selector button */}
                                    {props.agentType && props.onAgentClick && (
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                props.onAgentClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => [
                                                styles.actionChip,
                                                p.pressed ? styles.actionChipPressed : null,
                                            ]}
                                        >
                                            <Octicons
                                                name="cpu"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            <Text style={styles.actionChipText}>
                                                {props.agentType === 'claude'
                                                    ? t('agentInput.agent.claude')
                                                    : props.agentType === 'codex'
                                                        ? t('agentInput.agent.codex')
                                                        : t('agentInput.agent.gemini')}
                                            </Text>
                                        </Pressable>
                                    )}

                                    {/* Machine selector button */}
                                    {(props.machineName !== undefined) && props.onMachineClick && (
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                props.onMachineClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => [
                                                styles.actionChip,
                                                p.pressed ? styles.actionChipPressed : null,
                                            ]}
                                        >
                                            <Ionicons
                                                name="desktop-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            <Text style={styles.actionChipText}>
                                                {props.machineName === null
                                                    ? t('agentInput.noMachinesAvailable')
                                                    : truncateWithEllipsis(props.machineName, 12)}
                                            </Text>
                                        </Pressable>
                                    )}

                                    {/* Abort button */}
                                    {props.onAbort && (
                                        <Shaker ref={shakerRef}>
                                            <Pressable
                                                style={(p) => [
                                                    styles.actionButton,
                                                    p.pressed ? styles.actionButtonPressed : null,
                                                ]}
                                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                                onPress={handleAbortPress}
                                                disabled={isAborting}
                                            >
                                                {isAborting ? (
                                                    <ActivityIndicator
                                                        size="small"
                                                        color={theme.colors.button.secondary.tint}
                                                    />
                                                ) : (
                                                    <Octicons
                                                        name={"stop"}
                                                        size={16}
                                                        color={theme.colors.button.secondary.tint}
                                                    />
                                                )}
                                            </Pressable>
                                        </Shaker>
                                    )}

                                    {/* Git Status Badge */}
                                    <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} />
                                </View>

                                {/* Send/Voice button - aligned with first row */}
                                <View
                                    style={[
                                        styles.sendButton,
                                        (hasText || props.isSending || (props.onMicPress && !props.isMicActive))
                                            ? styles.sendButtonActive
                                            : styles.sendButtonInactive
                                    ]}
                                >
                                    <Pressable
                                        style={(p) => [
                                            styles.sendButtonInner,
                                            p.pressed ? styles.sendButtonInnerPressed : null,
                                        ]}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={() => {
                                            hapticsLight();
                                            if (hasText) {
                                                props.onSend();
                                            } else {
                                                props.onMicPress?.();
                                            }
                                        }}
                                        disabled={props.isSendDisabled || props.isSending || (!hasText && !props.onMicPress)}
                                    >
                                        {props.isSending ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : hasText ? (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        ) : props.onMicPress && !props.isMicActive ? (
                                            <Image
                                                source={require('@/assets/images/icon-voice-white.png')}
                                                style={styles.micIcon}
                                                tintColor={theme.colors.button.primary.tint}
                                            />
                                        ) : (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        )}
                                    </Pressable>
                                </View>
                            </View>

                            {/* Row 2: Path selector (separate line to match pre-PR272 layout) */}
                            {props.currentPath && props.onPathClick && (
                                <View style={styles.pathRow}>
                                    <View style={[styles.actionButtonsLeft, styles.actionButtonsLeftNoFlex]}>
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                props.onPathClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => [
                                                styles.actionChip,
                                                p.pressed ? styles.actionChipPressed : null,
                                            ]}
                                        >
                                            <Ionicons
                                                name="folder-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            <Text style={styles.actionChipText}>
                                                {props.currentPath}
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress }: { sessionId?: string, onPress?: () => void }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <Pressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                flex: 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </Pressable>
    );
}
