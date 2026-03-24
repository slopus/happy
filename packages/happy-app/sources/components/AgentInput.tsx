import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, TouchableWithoutFeedback, Image as RNImage, Pressable, Keyboard } from 'react-native';
import { Image } from 'expo-image';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { FloatingOverlay } from './FloatingOverlay';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { shouldSendOnEnter } from './agentInputKeyboard';
import { GitStatusBadge, useHasLoadedGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { log } from '@/log';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile } from '@/sync/profileUtils';
import { ImagePreview, LocalImage } from '@/components/ImagePreview';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import {
    buildClaudeModelMode,
    buildCodexModelMode,
    CLAUDE_MODEL_FAMILY_OPTIONS,
    ClaudeModelFamily,
    ClaudeReasoningEffort,
    CODEX_MODEL_FAMILY_OPTIONS,
    CodexModelFamily,
    CodexReasoningEffort,
    formatReasoningEffortLabel,
    FAST_MODE_ICON_COLOR,
    GEMINI_MODEL_OPTIONS,
    getClaudeReasoningOptions,
    getCodexReasoningOptions,
    getMaxContextSize,
    MODEL_MODE_DEFAULT,
    parseClaudeModelMode,
    parseCodexModelMode,
} from 'happy-wire';

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: (textSnapshot?: string) => void;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
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
        onPress?: () => void;
        action?: 'openPermission';
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
        contextWindowSize?: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex' | 'gemini';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    fastMode?: boolean;
    onFastModeChange?: (enabled: boolean) => void;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    profileId?: string | null;
    onProfileClick?: () => void;
    images?: LocalImage[];
    onImagesChange?: (images: LocalImage[]) => void;
    onImageButtonPress?: () => void;
    supportsImages?: boolean;
    isUploadingImages?: boolean;
    onImageDrop?: (files: File[]) => void;
}

const agentFlavorIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
};

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
    dragOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderWidth: 2,
        borderColor: '#007AFF',
        borderStyle: 'dashed',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        backgroundColor: 'rgba(0, 122, 255, 0.05)',
        pointerEvents: 'none',
        zIndex: 10,
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
    selectionDescription: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
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
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 8,
        flex: 1,
        overflow: 'hidden',
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
    iconButton: {
        width: 40,
        height: 40,
        justifyContent: 'center',
        alignItems: 'center',
    },
    iconButtonDisabled: {
        opacity: 0.4,
    },
}));

const getContextWarning = (contextSize: number, maxContextSize: number, alwaysShow: boolean = false, theme: Theme) => {
    const percentageUsed = (contextSize / maxContextSize) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 30) {
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
    const renderRadioOptions = <T extends string>(
        options: readonly { value: T; label: string; description?: string }[],
        selectedValue: T | null,
        onSelect: (value: T) => void,
    ) => options.map(option => {
        const isSelected = selectedValue === option.value;
        return (
            <Pressable key={option.value}
                onPress={() => { hapticsLight(); onSelect(option.value); }}
                style={({ pressed }) => [styles.selectionItem, pressed && styles.selectionItemPressed]}>
                <View style={[styles.radioButton, isSelected ? styles.radioButtonActive : styles.radioButtonInactive]}>
                    {isSelected && <View style={styles.radioButtonDot} />}
                </View>
                {option.description ? (
                    <View>
                        <Text style={[styles.selectionLabel, isSelected ? styles.selectionLabelActive : styles.selectionLabelInactive]}>
                            {option.label}
                        </Text>
                        <Text style={styles.selectionDescription}>{option.description}</Text>
                    </View>
                ) : (
                    <Text style={[styles.selectionLabel, isSelected ? styles.selectionLabelActive : styles.selectionLabelInactive]}>
                        {option.label}
                    </Text>
                )}
            </Pressable>
        );
    });
    const screenWidth = useWindowDimensions().width;

    // Check if this is a Codex or Gemini session
    // Use metadata.flavor for existing sessions, agentType prop for new sessions
    const isCodex = props.metadata?.flavor === 'codex' || props.agentType === 'codex';
    const isGemini = props.metadata?.flavor === 'gemini' || props.agentType === 'gemini';
    const isClaude = !isCodex && !isGemini;
    const selectedModelMode: ModelMode = props.modelMode || 'default';
    const codexSelection = React.useMemo<{ family: CodexModelFamily; effort: CodexReasoningEffort }>(() => {
        return parseCodexModelMode(selectedModelMode);
    }, [selectedModelMode]);
    const codexFamilyOptions = CODEX_MODEL_FAMILY_OPTIONS;
    const codexReasoningOptions = React.useMemo<Array<{ value: CodexReasoningEffort; label: string }>>(() => {
        const options = getCodexReasoningOptions(codexSelection.family);
        return options.map((value) => ({
            value,
            label: formatReasoningEffortLabel(value) ?? value,
        }));
    }, [codexSelection.family]);
    const handleCodexFamilyChange = React.useCallback((family: CodexModelFamily) => {
        if (!props.onModelModeChange) return;
        props.onModelModeChange(buildCodexModelMode(family, codexSelection.effort || 'medium'));
    }, [codexSelection.effort, props.onModelModeChange]);
    const handleCodexReasoningChange = React.useCallback((effort: CodexReasoningEffort) => {
        if (!props.onModelModeChange || codexSelection.family === MODEL_MODE_DEFAULT) return;
        props.onModelModeChange(buildCodexModelMode(codexSelection.family, effort));
    }, [codexSelection.family, props.onModelModeChange]);
    const claudeSelection = React.useMemo<{ family: ClaudeModelFamily; effort: ClaudeReasoningEffort | null }>(() => {
        return parseClaudeModelMode(selectedModelMode);
    }, [selectedModelMode]);
    const claudeFamilyOptions = CLAUDE_MODEL_FAMILY_OPTIONS;
    const claudeReasoningOptions = React.useMemo<Array<{ value: ClaudeReasoningEffort; label: string }>>(() => {
        const options = getClaudeReasoningOptions(claudeSelection.family);
        return options.map((value) => ({
            value,
            label: formatReasoningEffortLabel(value) ?? value,
        }));
    }, [claudeSelection.family]);
    const handleClaudeFamilyChange = React.useCallback((family: ClaudeModelFamily) => {
        if (!props.onModelModeChange) return;
        if (family === MODEL_MODE_DEFAULT) {
            props.onModelModeChange(MODEL_MODE_DEFAULT);
            return;
        }
        const validOptions = getClaudeReasoningOptions(family);
        const effort = claudeSelection.effort && validOptions.includes(claudeSelection.effort) ? claudeSelection.effort : validOptions[0];
        props.onModelModeChange(buildClaudeModelMode(family, effort));
    }, [claudeSelection.effort, props.onModelModeChange]);
    const handleClaudeReasoningChange = React.useCallback((effort: ClaudeReasoningEffort) => {
        if (!props.onModelModeChange || claudeSelection.family === MODEL_MODE_DEFAULT) return;
        props.onModelModeChange(buildClaudeModelMode(claudeSelection.family, effort));
    }, [claudeSelection.family, props.onModelModeChange]);
    const modelOptions = React.useMemo<Array<{ value: ModelMode; label: string; shortLabel: string; description: string }>>(() => {
        if (isGemini) return [...GEMINI_MODEL_OPTIONS];
        return [{ value: MODEL_MODE_DEFAULT, label: 'Use CLI configured model', shortLabel: 'CLI', description: 'Use profile/CLI defaults' }];
    }, [isGemini]);

    const currentModelLabel = React.useMemo(() => {
        if (isCodex) {
            return (codexFamilyOptions.find(o => o.value === codexSelection.family)?.shortLabel ?? '') + (codexSelection.family !== 'default' ? ` (${codexReasoningOptions.find(o => o.value === codexSelection.effort)?.label ?? codexSelection.effort})` : '');
        }
        if (isClaude && claudeSelection.family !== 'default') {
            const base = claudeFamilyOptions.find(o => o.value === claudeSelection.family)?.shortLabel ?? '';
            const is1m = typeof claudeSelection.family === 'string' && claudeSelection.family.includes('[1m]');
            const parts = [is1m ? '1M' : '', claudeReasoningOptions.find(o => o.value === claudeSelection.effort)?.label ?? ''].filter(Boolean);
            return base + (parts.length > 0 ? ` (${parts.join(', ')})` : '');
        }
        return modelOptions.find(o => o.value === selectedModelMode)?.shortLabel ?? '';
    }, [isCodex, isClaude, codexFamilyOptions, codexSelection, codexReasoningOptions, claudeFamilyOptions, claudeSelection, claudeReasoningOptions, modelOptions, selectedModelMode]);

    // Profile data
    const profiles = useSetting('profiles');
    const currentProfile = React.useMemo(() => {
        if (!props.profileId) return null;
        // Check custom profiles first
        const customProfile = profiles.find(p => p.id === props.profileId);
        if (customProfile) return customProfile;
        // Check built-in profiles
        return getBuiltInProfile(props.profileId);
    }, [profiles, props.profileId]);

    // Calculate context warning
    // Prefer dynamic contextWindowSize from CLI (e.g. Codex reports model_context_window),
    // fall back to static lookup by model/agent flavor
    const agentFlavor = props.metadata?.flavor || props.agentType || null;
    const maxContextSize = props.usageData?.contextWindowSize || getMaxContextSize(props.modelMode, agentFlavor);
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, maxContextSize, props.alwaysShowContextSize ?? false, theme)
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Drag and drop state (web only)
    const [isDragging, setIsDragging] = React.useState(false);
    const dragCounterRef = React.useRef(0);
    const dropZoneRef = React.useRef<View>(null);

    // Set up native drag event listeners for web
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.supportsImages || !props.onImageDrop) return;

        const element = dropZoneRef.current as unknown as HTMLElement | null;
        if (!element) return;

        const handleDragEnter = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounterRef.current++;
            setIsDragging(true);
        };

        const handleDragLeave = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounterRef.current--;
            if (dragCounterRef.current === 0) {
                setIsDragging(false);
            }
        };

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
        };

        const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
            dragCounterRef.current = 0;

            if (!e.dataTransfer) return;
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            if (files.length > 0) {
                props.onImageDrop!(files);
            }
        };

        element.addEventListener('dragenter', handleDragEnter);
        element.addEventListener('dragleave', handleDragLeave);
        element.addEventListener('dragover', handleDragOver);
        element.addEventListener('drop', handleDrop);

        return () => {
            element.removeEventListener('dragenter', handleDragEnter);
            element.removeEventListener('dragleave', handleDragLeave);
            element.removeEventListener('dragover', handleDragOver);
            element.removeEventListener('drop', handleDrop);
        };
    }, [props.supportsImages, props.onImageDrop]);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });
    const hasText = inputState.text.trim().length > 0 || props.value.trim().length > 0;

    // Keep a latest text snapshot to avoid stale parent-state reads during fast click-after-type sends.
    const latestTextRef = React.useRef(props.value);
    React.useEffect(() => {
        latestTextRef.current = props.value;
    }, [props.value]);

    // Sync inputState.text when props.value changes externally (e.g., after send clears the input).
    // Without this, inputState.text retains the old message text because prop changes don't trigger
    // onStateChange from MultiTextInput, causing hasText to stay true and resolveSendSnapshot()
    // to return the old text — which makes the send button show an arrow on an empty input and
    // allows re-sending the previous message.
    React.useEffect(() => {
        setInputState(prev => {
            if (prev.text !== props.value) {
                return { ...prev, text: props.value };
            }
            return prev;
        });
    }, [props.value]);

    // Keep the latest text in sync immediately so a fast tap on send doesn't use stale state.
    const handleTextChange = React.useCallback((text: string) => {
        latestTextRef.current = text;
        props.onChangeText(text);
    }, [props.onChangeText]);

    // Handle combined text and selection state changes.
    // Guards against stale selection-change callbacks (which may carry an outdated text value)
    // from overwriting correct state set synchronously by handleTextChange.
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        // Don't let stale callbacks overwrite latestTextRef with empty text
        if (newState.text || !latestTextRef.current) {
            latestTextRef.current = newState.text;
        }
        // Don't let stale callbacks overwrite non-empty inputState.text with empty text.
        // When the user legitimately clears text, latestTextRef is already empty
        // (set by handleTextChange first). When a stale callback fires, latestTextRef
        // still has the current text, so we can detect the stale case.
        setInputState(prev => {
            if (!newState.text && prev.text && latestTextRef.current) {
                // Stale callback — only update selection, keep the correct text
                return { ...prev, selection: newState.selection };
            }
            return newState;
        });
    }, []);

    const resolveSendSnapshot = React.useCallback((): string => {
        const candidates = [latestTextRef.current, inputState.text, props.value];
        for (const candidate of candidates) {
            if (candidate.trim().length > 0) {
                return candidate;
            }
        }
        return latestTextRef.current;
    }, [inputState.text, props.value]);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

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

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Settings modal state: 'model' shows model picker, 'permission' shows permission picker, false = closed
    const [showSettings, setShowSettings] = React.useState<'model' | 'permission' | false>(false);

    // Dismiss keyboard when settings overlay opens
    React.useEffect(() => {
        if (showSettings) {
            Keyboard.dismiss();
        }
    }, [showSettings]);

    // Handle settings button press (gear icon → model selection)
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => prev === 'model' ? false : 'model');
    }, []);

    // Handle permission mode text press (right-side text → permission mode selection)
    const handlePermissionPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => prev === 'permission' ? false : 'permission');
    }, []);

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
                const textSnapshot = resolveSendSnapshot();
                if (shouldSendOnEnter({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    enterToSendEnabled: agentInputEnterToSend,
                    textSnapshot,
                    isSending: props.isSending,
                    isSendDisabled: props.isSendDisabled,
                })) {
                    props.onSend(textSnapshot);
                    return true; // Key was handled
                }
                if (textSnapshot.trim() && (props.isSending || props.isSendDisabled)) {
                    return true;
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange) {
                const modeOrder: PermissionMode[] = isCodex
                    ? ['default', 'read-only', 'safe-yolo', 'yolo']
                    : ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo']; // Claude and Gemini share same modes
                const currentIndex = modeOrder.indexOf(props.permissionMode || 'default');
                const nextIndex = (currentIndex + 1) % modeOrder.length;
                props.onPermissionModeChange(modeOrder[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, resolveSendSnapshot, props.onSend, props.permissionMode, props.onPermissionModeChange, props.isSending, props.isSendDisabled]);

    const connectionStatusIndicator = props.connectionStatus ? (
        <>
            <StatusDot
                color={props.connectionStatus.dotColor}
                isPulsing={props.connectionStatus.isPulsing}
                size={6}
            />
            <Text style={{
                fontSize: 11,
                color: props.connectionStatus.color,
                ...Typography.default()
            }}>
                {props.connectionStatus.text}
            </Text>
        </>
    ) : null;

    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 16 : 8 }
        ]}>
            <View
                style={[
                    styles.innerContainer,
                    { maxWidth: layout.maxWidth },
                ]}
            >
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
                        <TouchableWithoutFeedback onPress={() => setShowSettings(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                        ]}>
                            <FloatingOverlay maxHeight={400} keyboardShouldPersistTaps="always">
                                {/* Tab bar - segmented control style */}
                                <View style={{
                                    flexDirection: 'row',
                                    borderRadius: 10,
                                    overflow: 'hidden',
                                    padding: 2,
                                    backgroundColor: theme.colors.surfaceHighest,
                                    margin: 8,
                                    marginBottom: 4,
                                }}>
                                    {(() => {
                                        const permissionLabel = isCodex
                                            ? (props.permissionMode === 'default' ? t('agentInput.codexPermissionMode.default') : props.permissionMode === 'read-only' ? t('agentInput.codexPermissionMode.readOnly') : props.permissionMode === 'safe-yolo' ? t('agentInput.codexPermissionMode.safeYolo') : props.permissionMode === 'yolo' ? t('agentInput.codexPermissionMode.yolo') : '')
                                            : isGemini
                                                ? (props.permissionMode === 'default' ? t('agentInput.geminiPermissionMode.default') : props.permissionMode === 'read-only' ? t('agentInput.geminiPermissionMode.readOnly') : props.permissionMode === 'safe-yolo' ? t('agentInput.geminiPermissionMode.safeYolo') : props.permissionMode === 'yolo' ? t('agentInput.geminiPermissionMode.yolo') : '')
                                                : (props.permissionMode === 'default' ? t('agentInput.permissionMode.default') : props.permissionMode === 'acceptEdits' ? t('agentInput.permissionMode.acceptEdits') : props.permissionMode === 'plan' ? t('agentInput.permissionMode.plan') : props.permissionMode === 'bypassPermissions' ? t('agentInput.permissionMode.bypassPermissions') : props.permissionMode === 'yolo' ? t('agentInput.permissionMode.yolo') : '');
                                        const currentModelSubtitle: React.ReactNode = props.fastMode
                                            ? <>{currentModelLabel} <MaterialCommunityIcons name="lightning-bolt" size={10} color={FAST_MODE_ICON_COLOR} /></>
                                            : currentModelLabel;
                                        const tabs = [
                                            { key: 'model' as const, label: t('agentInput.model.title'), subtitle: currentModelSubtitle },
                                            { key: 'permission' as const, label: isCodex ? t('agentInput.codexPermissionMode.title') : isGemini ? t('agentInput.geminiPermissionMode.title') : t('agentInput.permissionMode.title'), subtitle: permissionLabel },
                                        ];
                                        return tabs.map((tab) => {
                                            const isActive = showSettings === tab.key;
                                            return (
                                                <Pressable
                                                    key={tab.key}
                                                    onPress={() => {
                                                        if (showSettings === tab.key) return;
                                                        hapticsLight();
                                                        setShowSettings(tab.key);
                                                    }}
                                                    style={[{
                                                        flex: 1,
                                                        alignItems: 'center',
                                                        paddingVertical: 6,
                                                        borderRadius: 8,
                                                    }, isActive && {
                                                        backgroundColor: theme.colors.surface,
                                                        shadowColor: '#000',
                                                        shadowOffset: { width: 0, height: 1 },
                                                        shadowOpacity: 0.1,
                                                        shadowRadius: 2,
                                                        elevation: 2,
                                                    }]}
                                                >
                                                    <Text style={{
                                                        fontSize: 13,
                                                        color: isActive ? theme.colors.text : theme.colors.textSecondary,
                                                        ...Typography.default(isActive ? 'semiBold' : 'regular'),
                                                    }}>
                                                        {tab.label}
                                                    </Text>
                                                    {tab.subtitle ? (
                                                        <Text style={{
                                                            fontSize: 10,
                                                            color: theme.colors.textSecondary,
                                                            marginTop: 1,
                                                            ...Typography.default(),
                                                        }} numberOfLines={1}>
                                                            {tab.subtitle}
                                                        </Text>
                                                    ) : null}
                                                </Pressable>
                                            );
                                        });
                                    })()}
                                </View>

                                {/* Permission Mode Section */}
                                {showSettings === 'permission' && <View style={styles.overlaySection}>
                                    {((isCodex || isGemini)
                                        ? (['default', 'read-only', 'safe-yolo', 'yolo'] as const)
                                        : (['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo'] as const)
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
                                            yolo: { label: t('agentInput.permissionMode.yolo') },
                                        };
                                        const config = modeConfig[mode as keyof typeof modeConfig];
                                        if (!config) return null;
                                        const isSelected = props.permissionMode === mode;

                                        return (
                                            <Pressable
                                                key={mode}
                                                onPress={() => handleSettingsSelect(mode)}
                                                style={({ pressed }) => ({
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent'
                                                })}
                                            >
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 8,
                                                    borderWidth: 2,
                                                    borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginRight: 12
                                                }}>
                                                    {isSelected && (
                                                        <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: theme.colors.radio.dot
                                                        }} />
                                                    )}
                                                </View>
                                                <Text style={{
                                                    fontSize: 14,
                                                    color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                    ...Typography.default()
                                                }}>
                                                    {config.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>}

                                {/* Model Section */}
                                {showSettings === 'model' && <View style={{ paddingVertical: 8 }}>
                                    {isCodex ? (
                                        <>
                                            {renderRadioOptions(codexFamilyOptions, codexSelection.family, handleCodexFamilyChange)}
                                            {codexSelection.family !== 'default' && (
                                                <>
                                                    <View style={[styles.overlayDivider, { marginTop: 4, marginBottom: 6 }]} />
                                                    <Text style={{
                                                        fontSize: 12,
                                                        fontWeight: '600',
                                                        color: theme.colors.textSecondary,
                                                        paddingHorizontal: 16,
                                                        paddingBottom: 4,
                                                        ...Typography.default('semiBold')
                                                    }}>
                                                        {t('agentInput.model.reasoningEffort')}
                                                    </Text>
                                                    {renderRadioOptions(codexReasoningOptions, codexSelection.effort, handleCodexReasoningChange)}
                                                    <View style={[styles.overlayDivider, { marginTop: 4, marginBottom: 6 }]} />
                                                    <View style={{
                                                        flexDirection: 'row',
                                                        alignItems: 'center',
                                                        justifyContent: 'space-between',
                                                        paddingHorizontal: 16,
                                                        paddingVertical: 8,
                                                    }}>
                                                        <Text style={{
                                                            fontSize: 12,
                                                            fontWeight: '600',
                                                            color: theme.colors.textSecondary,
                                                            ...Typography.default('semiBold')
                                                        }}>
                                                            {t('agentInput.model.fastMode')}
                                                        </Text>
                                                        <Switch
                                                            value={!!props.fastMode}
                                                            onValueChange={(value) => {
                                                                hapticsLight();
                                                                props.onFastModeChange?.(value);
                                                            }}
                                                        />
                                                    </View>
                                                </>
                                            )}
                                        </>
                                    ) : isClaude ? (
                                        <>
                                            {renderRadioOptions(claudeFamilyOptions, claudeSelection.family, handleClaudeFamilyChange)}
                                            {claudeSelection.family !== 'default' && (
                                                <>
                                                    <View style={[styles.overlayDivider, { marginTop: 4, marginBottom: 6 }]} />
                                                    <Text style={{
                                                        fontSize: 12,
                                                        fontWeight: '600',
                                                        color: theme.colors.textSecondary,
                                                        paddingHorizontal: 16,
                                                        paddingBottom: 4,
                                                        ...Typography.default('semiBold')
                                                    }}>
                                                        {t('agentInput.model.reasoningEffort')}
                                                    </Text>
                                                    {renderRadioOptions(claudeReasoningOptions, claudeSelection.effort, handleClaudeReasoningChange)}
                                                </>
                                            )}
                                        </>
                                    ) : (
                                        renderRadioOptions(modelOptions, selectedModelMode, (v) => props.onModelModeChange?.(v))
                                    )}
                                </View>}

                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Connection status, context warning, and permission mode */}
                {(props.connectionStatus || contextWarning || props.permissionMode) && (
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16,
                        paddingBottom: 4,
                        minHeight: 20, // Fixed minimum height to prevent jumping
                    }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 11 }}>
                            {props.connectionStatus && (
                                <>
                                    {(props.connectionStatus.onPress || props.connectionStatus.action) ? (
                                        <Pressable
                                            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                                            onPress={() => {
                                                if (props.connectionStatus?.action === 'openPermission') {
                                                    hapticsLight();
                                                    setShowSettings(prev => prev === 'permission' ? false : 'permission');
                                                } else {
                                                    props.connectionStatus?.onPress?.();
                                                }
                                            }}
                                            style={({ pressed }) => ({
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                gap: 4,
                                                opacity: pressed ? 0.7 : 1
                                            })}
                                        >
                                            {connectionStatusIndicator}
                                        </Pressable>
                                    ) : (
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                            {connectionStatusIndicator}
                                        </View>
                                    )}
                                    {/* CLI Status - only shown when provided (wizard only) */}
                                    {props.connectionStatus.cliStatus && (
                                        <>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.claude
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    {props.connectionStatus.cliStatus.claude ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.claude
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    claude
                                                </Text>
                                            </View>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.codex
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    {props.connectionStatus.cliStatus.codex ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.codex
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    codex
                                                </Text>
                                            </View>
                                            {props.connectionStatus.cliStatus.gemini !== undefined && (
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: props.connectionStatus.cliStatus.gemini
                                                            ? theme.colors.success
                                                            : theme.colors.textDestructive,
                                                        ...Typography.default()
                                                    }}>
                                                        {props.connectionStatus.cliStatus.gemini ? '✓' : '✗'}
                                                    </Text>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: props.connectionStatus.cliStatus.gemini
                                                            ? theme.colors.success
                                                            : theme.colors.textDestructive,
                                                        ...Typography.default()
                                                    }}>
                                                        gemini
                                                    </Text>
                                                </View>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                            {contextWarning && (
                                <Text style={{
                                    fontSize: 11,
                                    color: contextWarning.color,
                                    marginLeft: props.connectionStatus ? 8 : 0,
                                    ...Typography.default()
                                }}>
                                    {props.connectionStatus ? '• ' : ''}{contextWarning.text}
                                </Text>
                            )}
                        </View>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                            zIndex: 1001,
                        }}>
                            {props.onModelModeChange && (
                                <Pressable hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} onPress={() => { hapticsLight(); setShowSettings(prev => prev === 'model' ? false : 'model'); }} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.textSecondary,
                                        ...Typography.default()
                                    }}>
                                        {currentModelLabel}
                                        {props.fastMode && <>{' '}<MaterialCommunityIcons name="lightning-bolt" size={11} color={FAST_MODE_ICON_COLOR} /></>}
                                    </Text>
                                </Pressable>
                            )}
                            {props.permissionMode && (
                                <Pressable hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} onPress={handlePermissionPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: props.permissionMode === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                            props.permissionMode === 'bypassPermissions' ? theme.colors.permission.bypass :
                                                props.permissionMode === 'plan' ? theme.colors.permission.plan :
                                                    props.permissionMode === 'read-only' ? theme.colors.permission.readOnly :
                                                        props.permissionMode === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                            props.permissionMode === 'yolo' ? theme.colors.permission.yolo :
                                                                theme.colors.textSecondary,
                                        ...Typography.default()
                                    }}>
                                        {isCodex ? (
                                            props.permissionMode === 'default' ? t('agentInput.codexPermissionMode.default') :
                                                props.permissionMode === 'read-only' ? t('agentInput.codexPermissionMode.badgeReadOnly') :
                                                    props.permissionMode === 'safe-yolo' ? t('agentInput.codexPermissionMode.badgeSafeYolo') :
                                                        props.permissionMode === 'yolo' ? t('agentInput.codexPermissionMode.badgeYolo') : ''
                                        ) : isGemini ? (
                                            props.permissionMode === 'default' ? t('agentInput.geminiPermissionMode.default') :
                                                props.permissionMode === 'read-only' ? t('agentInput.geminiPermissionMode.badgeReadOnly') :
                                                    props.permissionMode === 'safe-yolo' ? t('agentInput.geminiPermissionMode.badgeSafeYolo') :
                                                        props.permissionMode === 'yolo' ? t('agentInput.geminiPermissionMode.badgeYolo') : ''
                                        ) : (
                                            props.permissionMode === 'default' ? t('agentInput.permissionMode.default') :
                                                props.permissionMode === 'acceptEdits' ? t('agentInput.permissionMode.badgeAcceptAllEdits') :
                                                    props.permissionMode === 'bypassPermissions' ? t('agentInput.permissionMode.badgeBypassAllPermissions') :
                                                        props.permissionMode === 'yolo' ? t('agentInput.permissionMode.badgeYolo') :
                                                            props.permissionMode === 'plan' ? t('agentInput.permissionMode.badgePlanMode') : ''
                                        )}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </View>
                )}

                {/* Box 1: Context Information (Machine + Path) - Only show if either exists */}
                {(props.machineName !== undefined || props.currentPath) && (
                    <View style={{
                        backgroundColor: theme.colors.surfacePressed,
                        borderRadius: 12,
                        padding: 8,
                        marginBottom: 8,
                        gap: 4,
                    }}>
                        {/* Machine chip */}
                        {props.machineName !== undefined && props.onMachineClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onMachineClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                })}
                            >
                                <Ionicons
                                    name="desktop-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.machineName === null ? t('agentInput.noMachinesAvailable') : props.machineName}
                                </Text>
                            </Pressable>
                        )}

                        {/* Path chip */}
                        {props.currentPath && props.onPathClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onPathClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                    flexShrink: 1,
                                    minWidth: 0,
                                })}
                            >
                                <Ionicons
                                    name="folder-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text
                                    numberOfLines={1}
                                    style={{
                                        fontSize: 13,
                                        color: theme.colors.text,
                                        fontWeight: '600',
                                        flexShrink: 1,
                                        ...Typography.default('semiBold'),
                                    }}
                                >
                                    {props.currentPath}
                                </Text>
                            </Pressable>
                        )}
                        {/* Path hint (non-clickable) */}
                        {props.currentPath && !props.onPathClick && (
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    height: 32,
                                    gap: 6,
                                    flexShrink: 1,
                                    minWidth: 0,
                                }}
                            >
                                <Ionicons
                                    name="folder-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text
                                    numberOfLines={1}
                                    style={{
                                        fontSize: 13,
                                        color: theme.colors.textSecondary,
                                        flexShrink: 1,
                                        ...Typography.default('regular'),
                                    }}
                                >
                                    {props.currentPath}
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View ref={dropZoneRef} style={styles.unifiedPanel}>
                    {/* Drag overlay */}
                    {isDragging && <View style={styles.dragOverlay} />}

                    {/* Image preview */}
                    {props.images && props.images.length > 0 && props.onImagesChange && (
                        <ImagePreview
                            images={props.images}
                            onRemove={(index) => {
                                const newImages = props.images!.filter((_, i) => i !== index);
                                props.onImagesChange!(newImages);
                            }}
                            disabled={props.isUploadingImages}
                        />
                    )}

                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={handleTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={120}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                            {/* Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <View style={styles.actionButtonsLeft}>

                                {/* Settings button */}
                                {props.onPermissionModeChange && (
                                    <Pressable
                                        onPress={handleSettingsPress}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Octicons
                                            name={'gear'}
                                            size={16}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}

                                {/* Profile selector button - FIRST */}
                                {props.profileId && props.onProfileClick && (
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            props.onProfileClick?.();
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                            gap: 6,
                                        })}
                                    >
                                        <Ionicons
                                            name="person-outline"
                                            size={14}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.button.secondary.tint,
                                            fontWeight: '600',
                                            ...Typography.default('semiBold'),
                                        }}>
                                            {currentProfile?.name || 'Select Profile'}
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
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                            gap: 6,
                                        })}
                                    >
                                        {(() => {
                                            const isCodex = props.agentType === 'codex';
                                            const iconSize = isCodex ? 15 : 18;
                                            const iconStyle = {
                                                width: iconSize,
                                                height: iconSize,
                                                marginLeft: isCodex ? 2 : 0,
                                                marginRight: isCodex ? 1 : 0,
                                            };
                                            return (
                                                <Image
                                                    source={agentFlavorIcons[props.agentType as keyof typeof agentFlavorIcons] || agentFlavorIcons.claude}
                                                    style={iconStyle}
                                                    contentFit="contain"
                                                    tintColor={isCodex ? theme.colors.button.secondary.tint : undefined}
                                                />
                                            );
                                        })()}
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.button.secondary.tint,
                                            fontWeight: '600',
                                            ...Typography.default('semiBold'),
                                        }}>
                                            {props.agentType === 'claude' ? t('agentInput.agent.claude') : props.agentType === 'codex' ? t('agentInput.agent.codex') : t('agentInput.agent.gemini')}
                                        </Text>
                                    </Pressable>
                                )}

                                {/* Abort button */}
                                {props.onAbort && (
                                    <Shaker ref={shakerRef}>
                                        <Pressable
                                            style={(p) => ({
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                borderRadius: Platform.select({ default: 16, android: 20 }),
                                                paddingHorizontal: 8,
                                                paddingVertical: 6,
                                                justifyContent: 'center',
                                                height: 32,
                                                opacity: p.pressed ? 0.7 : 1,
                                            })}
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
                                <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} onBlank={() => inputRef.current?.focus()} />
                                </View>

                                {/* Image button */}
                                {props.onImageButtonPress && (
                                    <Pressable
                                        onPress={props.supportsImages !== false ? props.onImageButtonPress : () => {
                                            Modal.alert('Not Supported', 'This AI does not support images');
                                        }}
                                        style={[
                                            styles.iconButton,
                                            props.supportsImages === false && styles.iconButtonDisabled
                                        ]}
                                        disabled={props.isUploadingImages}
                                    >
                                        <Ionicons
                                            name="image-outline"
                                            size={24}
                                            color={props.supportsImages !== false ? theme.colors.text : theme.colors.textSecondary}
                                        />
                                    </Pressable>
                                )}

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
                                        style={(p) => ({
                                            width: '100%',
                                            height: '100%',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={() => {
                                            const textSnapshot = resolveSendSnapshot();
                                            log.log(`[SEND_DEBUG][INPUT] press hasText=${hasText} latestLen=${latestTextRef.current.trim().length} stateLen=${inputState.text.trim().length} propLen=${props.value.trim().length} pickedLen=${textSnapshot.trim().length} mic=${props.onMicPress ? 'yes' : 'no'} disabled=${props.isSendDisabled || props.isSending ? 'yes' : 'no'}`);
                                            if (textSnapshot.trim()) {
                                                hapticsLight();
                                                props.onSend(textSnapshot);
                                                return;
                                            }
                                            if (props.onMicPress) {
                                                hapticsLight();
                                                props.onMicPress();
                                            }
                                        }}
                                        accessibilityState={{
                                            disabled: !!(props.isSendDisabled || props.isSending || (!hasText && !props.onMicPress)),
                                        }}
                                        disabled={props.isSendDisabled || props.isSending}
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
                                                style={{
                                                    width: 24,
                                                    height: 24,
                                                }}
                                                tintColor={theme.colors.button.primary.tint}
                                            />
                                        ) : (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 },
                                                    theme.dark && { opacity: 0.5 },
                                                ]}
                                            />
                                        )}
                                    </Pressable>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress, onBlank }: { sessionId?: string, onPress?: () => void, onBlank?: () => void }) {
    const hasLoadedGitStatus = useHasLoadedGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                flex: 1,
                overflow: 'hidden',
            }}
        >
            <Pressable
                style={(p) => ({
                    opacity: p.pressed ? 0.7 : 1,
                })}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                onPress={() => {
                    hapticsLight();
                    onPress?.();
                }}
            >
                {hasLoadedGitStatus ? (
                    <GitStatusBadge sessionId={sessionId} />
                ) : (
                    <Octicons
                        name="git-branch"
                        size={16}
                        color={theme.colors.button.secondary.tint}
                    />
                )}
            </Pressable>
            <Pressable
                style={{
                    flex: 1
                }}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                onPress={() => {
                    onBlank?.();
                }}
            >
                <Text>
                    
                </Text>
            </Pressable>
        </View>
    );
}
