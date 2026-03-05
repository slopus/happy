import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, TouchableWithoutFeedback, Image as RNImage, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { layout } from './layout';
import { useContentMaxWidth } from './SidebarNavigator';
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
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { MCPServerPopup } from '@/components/MCPServerPopup';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting, useSessionProjectGitStatus, useSessionGitStatus, useLocalSettingMutable } from '@/sync/storage';
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
    onMicLongPress?: () => void;
    isMicActive?: boolean;
    isMicContinuous?: boolean;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    modelMode?: ModelMode;
    onModelModeChange?: (mode: ModelMode) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    onKillAndArchive?: () => void | Promise<void>;
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
    onAttach?: () => void;
    // MCP servers
    mcpServers?: Array<{ name: string; enabled: boolean; type: string }>;
    mcpLoading?: boolean;
    onMcpToggle?: (name: string, enabled: boolean) => void;
    onMcpPress?: () => void;
    showMcpPopup?: boolean;
    onMcpPopupDismiss?: () => void;
    pendingImages?: Array<{ url: string; mediaType: string; width: number; height: number; localUri: string }>;
    onRemoveImage?: (index: number) => void;
    pendingDocuments?: Array<{ url: string; mediaType: string; fileName: string; fileSize: number }>;
    onRemoveDocument?: (index: number) => void;
    isUploadingImage?: boolean;
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
    showSettingsExternal?: boolean;
    onSettingsVisibilityChange?: (visible: boolean) => void;
    onSharePress?: () => void;
}

const MAX_CONTEXT_SIZE = 190000;

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
        width: 46,
        height: 46,
        borderRadius: 23,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 4,
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

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const expandedMaxWidth = useContentMaxWidth();
    const [sendButtonPosition, setSendButtonPosition] = useLocalSettingMutable('sendButtonPosition');
    const isSendLeft = sendButtonPosition === 'left';

    const hasText = props.value.trim().length > 0;
    const hasPendingImages = (props.pendingImages?.length ?? 0) > 0;
    const hasPendingDocuments = (props.pendingDocuments?.length ?? 0) > 0;
    const hasPendingAttachments = hasPendingImages || hasPendingDocuments;

    // Check if this is a Codex or Gemini session
    // Use metadata.flavor for existing sessions, agentType prop for new sessions
    const isCodex = props.metadata?.flavor === 'codex' || props.agentType === 'codex';
    const isGemini = props.metadata?.flavor === 'gemini' || props.agentType === 'gemini';

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
        // console.log('📝 Input state changed:', JSON.stringify(newState));
        setInputState(newState);
    }, []);

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

    // Settings modal state
    const [showSettings, setShowSettingsInternal] = React.useState(false);
    const setShowSettings = React.useCallback((value: boolean | ((prev: boolean) => boolean)) => {
        setShowSettingsInternal(prev => {
            const next = typeof value === 'function' ? value(prev) : value;
            props.onSettingsVisibilityChange?.(next);
            return next;
        });
    }, [props.onSettingsVisibilityChange]);

    // Sync with external showSettings prop
    React.useEffect(() => {
        if (props.showSettingsExternal !== undefined) {
            setShowSettingsInternal(props.showSettingsExternal);
        }
    }, [props.showSettingsExternal]);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => !prev);
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

    // Handle long press on abort button — kill session and archive
    const handleKillAndArchivePress = React.useCallback(async () => {
        if (!props.onKillAndArchive) return;

        hapticsError();
        setIsAborting(true);

        try {
            await props.onKillAndArchive();
        } catch (error) {
            shakerRef.current?.shake();
            console.error('Kill and archive failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onKillAndArchive]);

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
            // Cmd+Enter always sends; Shift+Enter sends when Enter alone doesn't
            if (event.key === 'Enter' && (event.metaKey || (!agentInputEnterToSend && event.shiftKey))) {
                if (props.value.trim()) {
                    props.onSend();
                    return true;
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange) {
                const modeOrder: PermissionMode[] = isCodex
                    ? ['default', 'read-only', 'safe-yolo', 'yolo']
                    : ['default', 'acceptEdits', 'plan', 'bypassPermissions']; // Claude and Gemini share same modes
                const currentIndex = modeOrder.indexOf(props.permissionMode || 'default');
                const nextIndex = (currentIndex + 1) % modeOrder.length;
                props.onPermissionModeChange(modeOrder[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.value, props.onSend, props.permissionMode, props.onPermissionModeChange]);




    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 16 : 8 }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: expandedMaxWidth || layout.maxWidth }
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

                {/* MCP Server Popup */}
                {props.showMcpPopup && props.mcpServers && (
                    <>
                        <TouchableWithoutFeedback onPress={() => props.onMcpPopupDismiss?.()}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[styles.settingsOverlay, { paddingHorizontal: screenWidth > 700 ? 0 : 8 }]}>
                            <MCPServerPopup
                                servers={props.mcpServers}
                                loading={props.mcpLoading || false}
                                onToggle={(name, enabled) => props.onMcpToggle?.(name, enabled)}
                            />
                        </View>
                    </>
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
                            <FloatingOverlay maxHeight={500} keyboardShouldPersistTaps="always">
                                {/* Permission Mode Section */}
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {isCodex ? t('agentInput.codexPermissionMode.title') : isGemini ? t('agentInput.geminiPermissionMode.title') : t('agentInput.permissionMode.title')}
                                    </Text>
                                    {((isCodex || isGemini)
                                        ? (['default', 'read-only', 'safe-yolo', 'yolo'] as const)
                                        : (['default', 'acceptEdits', 'plan', 'bypassPermissions', 'zen'] as const)
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
                                            zen: { label: t('agentInput.permissionMode.zen') },
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
                                </View>

                                {/* Divider */}
                                <View style={{
                                    height: 1,
                                    backgroundColor: theme.colors.divider,
                                    marginHorizontal: 16
                                }} />

                                {/* Model Section */}
                                <View style={{ paddingVertical: 8 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        fontWeight: '600',
                                        color: theme.colors.textSecondary,
                                        paddingHorizontal: 16,
                                        paddingBottom: 4,
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('agentInput.model.title')}
                                    </Text>
                                    {isGemini ? (
                                        // Gemini model selector
                                        (['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const).map((model) => {
                                            const modelConfig = {
                                                'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', description: 'Most capable' },
                                                'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', description: 'Fast & efficient' },
                                                'gemini-2.5-flash-lite': { label: 'Gemini 2.5 Flash Lite', description: 'Fastest' },
                                            };
                                            const config = modelConfig[model];
                                            const isSelected = props.modelMode === model;

                                            return (
                                                <Pressable
                                                    key={model}
                                                    onPress={() => {
                                                        hapticsLight();
                                                        props.onModelModeChange?.(model);
                                                    }}
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
                                                    <View>
                                                        <Text style={{
                                                            fontSize: 14,
                                                            color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                            ...Typography.default()
                                                        }}>
                                                            {config.label}
                                                        </Text>
                                                        <Text style={{
                                                            fontSize: 11,
                                                            color: theme.colors.textSecondary,
                                                            ...Typography.default()
                                                        }}>
                                                            {config.description}
                                                        </Text>
                                                    </View>
                                                </Pressable>
                                            );
                                        })
                                    ) : (
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.textSecondary,
                                            paddingHorizontal: 16,
                                            paddingVertical: 8,
                                            ...Typography.default()
                                        }}>
                                            {t('agentInput.model.configureInCli')}
                                        </Text>
                                    )}
                                </View>

                                {/* Git Status - quick link */}
                                {props.sessionId && props.onFileViewerPress && (
                                    <>
                                        <View style={{
                                            height: 1,
                                            backgroundColor: theme.colors.divider,
                                            marginHorizontal: 16
                                        }} />
                                        <Pressable
                                            onPress={() => {
                                                props.onFileViewerPress?.();
                                                setShowSettings(false);
                                            }}
                                            style={({ pressed }) => ({
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                paddingHorizontal: 16,
                                                paddingVertical: 10,
                                                backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                                gap: 12,
                                            })}
                                        >
                                            <Octicons name="git-branch" size={16} color={theme.colors.text} />
                                            <Text style={{
                                                fontSize: 14,
                                                color: theme.colors.text,
                                                ...Typography.default()
                                            }}>
                                                Git
                                            </Text>
                                            <View style={{ flex: 1 }} />
                                            <GitStatusBadgeInline sessionId={props.sessionId} />
                                        </Pressable>
                                    </>
                                )}

                                {/* Share button */}
                                {props.onSharePress && (
                                    <>
                                        <View style={{
                                            height: 1,
                                            backgroundColor: theme.colors.divider,
                                            marginHorizontal: 16
                                        }} />
                                        <Pressable
                                            onPress={() => {
                                                props.onSharePress?.();
                                                setShowSettings(false);
                                            }}
                                            style={({ pressed }) => ({
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                paddingHorizontal: 16,
                                                paddingVertical: 10,
                                                backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                                gap: 12,
                                            })}
                                        >
                                            <Ionicons name="share-outline" size={16} color={theme.colors.text} />
                                            <Text style={{
                                                fontSize: 14,
                                                color: theme.colors.text,
                                                ...Typography.default()
                                            }}>
                                                Share
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
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
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
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
                                    </View>
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
                            flexDirection: 'column',
                            alignItems: 'flex-end',
                            minWidth: 150, // Fixed minimum width to prevent layout shift
                        }}>
                            {props.permissionMode && (
                                <Text style={{
                                    fontSize: 11,
                                    color: props.permissionMode === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                        props.permissionMode === 'bypassPermissions' ? theme.colors.permission.bypass :
                                            props.permissionMode === 'plan' ? theme.colors.permission.plan :
                                                props.permissionMode === 'zen' ? theme.colors.permission.zen :
                                                    props.permissionMode === 'read-only' ? theme.colors.permission.readOnly :
                                                        props.permissionMode === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                            props.permissionMode === 'yolo' ? theme.colors.permission.yolo :
                                                                theme.colors.textSecondary, // Use secondary text color for default
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
                                                    props.permissionMode === 'plan' ? t('agentInput.permissionMode.badgePlanMode') :
                                                        props.permissionMode === 'zen' ? t('agentInput.permissionMode.badgeZen') : ''
                                    )}
                                </Text>
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
                                })}
                            >
                                <Ionicons
                                    name="folder-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.currentPath}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={styles.unifiedPanel}>
                    {/* Pending images preview */}
                    {props.pendingImages && props.pendingImages.length > 0 && (
                        <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 8, flexWrap: 'wrap' }}>
                            {props.pendingImages.map((img, index) => (
                                <View key={index} style={{ position: 'relative' }}>
                                    <Image
                                        source={{ uri: img.localUri }}
                                        style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: theme.colors.surfaceHighest }}
                                    />
                                    <Pressable
                                        onPress={() => props.onRemoveImage?.(index)}
                                        style={{
                                            position: 'absolute',
                                            top: -6,
                                            right: -6,
                                            width: 20,
                                            height: 20,
                                            borderRadius: 10,
                                            backgroundColor: theme.colors.surfaceHighest,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            borderWidth: 1,
                                            borderColor: theme.colors.divider,
                                        }}
                                    >
                                        <Ionicons name="close" size={12} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            ))}
                        </View>
                    )}

                    {/* Pending documents preview */}
                    {props.pendingDocuments && props.pendingDocuments.length > 0 && (
                        <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 10, flexWrap: 'wrap' }}>
                            {props.pendingDocuments.map((doc, index) => (
                                <View key={index} style={{
                                    position: 'relative',
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: 8,
                                    paddingVertical: 4,
                                    paddingRight: 16,
                                }}>
                                    <Ionicons name="document-text-outline" size={20} color={theme.colors.text} />
                                    <View style={{ flexShrink: 1 }}>
                                        <Text style={{ fontSize: 13, color: theme.colors.text, maxWidth: 140, fontWeight: '700' }} numberOfLines={1}>
                                            {doc.fileName}
                                        </Text>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginTop: 1 }}>
                                            {formatFileSize(doc.fileSize)}
                                        </Text>
                                    </View>
                                    <Pressable
                                        onPress={() => props.onRemoveDocument?.(index)}
                                        style={{
                                            position: 'absolute',
                                            top: -4,
                                            right: 0,
                                            width: 18,
                                            height: 18,
                                            borderRadius: 9,
                                            backgroundColor: theme.colors.surfaceHighest,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        <Ionicons name="close" size={11} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            ))}
                        </View>
                    )}

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
                            maxHeight={Math.max(120, Math.floor(screenHeight * 0.4))}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                            {/* Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status */}
                            {/* Send button position: left (row-reverse) or right (row) */}
                            <View style={{ flexDirection: isSendLeft ? 'row-reverse' : 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <View style={[styles.actionButtonsLeft, isSendLeft && { flexDirection: 'row-reverse' }]}>

                                {/* Attach button (images + documents) */}
                                {props.onAttach && (
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            props.onAttach?.();
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 20, android: 22 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 8,
                                            justifyContent: 'center',
                                            height: 38,
                                            opacity: p.pressed ? 0.7 : (props.isUploadingImage ? 0.5 : 1),
                                        })}
                                        disabled={props.isUploadingImage}
                                    >
                                        {props.isUploadingImage ? (
                                            <ActivityIndicator size={18} color={theme.colors.button.secondary.tint} />
                                        ) : (
                                            <Ionicons
                                                name="attach"
                                                size={32}
                                                color={(props.pendingImages?.length || props.pendingDocuments?.length)
                                                    ? theme.colors.textLink
                                                    : theme.colors.button.secondary.tint}
                                            />
                                        )}
                                    </Pressable>
                                )}

                                {/* MCP Servers button */}
                                {props.onMcpPress && (
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            props.onMcpPress?.();
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row' as const,
                                            alignItems: 'center' as const,
                                            borderRadius: 20,
                                            paddingHorizontal: 10,
                                            paddingVertical: 8,
                                            justifyContent: 'center' as const,
                                            height: 38,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Ionicons
                                            name="extension-puzzle-outline"
                                            size={20}
                                            color={theme.colors.button.secondary.tint}
                                            style={{ opacity: 0.4 }}
                                        />
                                        {props.mcpServers && props.mcpServers.some(s => !s.enabled) && (
                                            <View style={{
                                                position: 'absolute' as const,
                                                top: 4,
                                                right: 4,
                                                backgroundColor: theme.colors.textLink,
                                                borderRadius: 6,
                                                minWidth: 12,
                                                height: 12,
                                                alignItems: 'center' as const,
                                                justifyContent: 'center' as const,
                                                paddingHorizontal: 2,
                                            }}>
                                                <Text style={{ fontSize: 8, color: '#fff', fontWeight: '700' }}>
                                                    {props.mcpServers.filter(s => s.enabled).length}
                                                </Text>
                                            </View>
                                        )}
                                    </Pressable>
                                )}

                                {/* Mirror send button position toggle */}
                                <Pressable
                                    onPress={() => {
                                        hapticsLight();
                                        setSendButtonPosition(isSendLeft ? 'right' : 'left');
                                    }}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    style={(p) => ({
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        height: 38,
                                        width: 32,
                                        opacity: p.pressed ? 0.5 : 0.4,
                                    })}
                                >
                                    <Ionicons
                                        name="swap-horizontal"
                                        size={20}
                                        color={theme.colors.button.secondary.tint}
                                    />
                                </Pressable>

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
                                        <Octicons
                                            name="cpu"
                                            size={14}
                                            color={theme.colors.button.secondary.tint}
                                        />
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

                                </View>

                                {/* Stop button (separate, when agent is working) + Send button */}
                                <View style={{ flexDirection: isSendLeft ? 'row-reverse' : 'row', alignItems: 'center', gap: 4 }}>
                                    {/* Stop button — only when agent is working */}
                                    {props.showAbortButton && props.onAbort && (
                                        <Shaker ref={shakerRef}>
                                            <Pressable
                                                onPress={handleAbortPress}
                                                onLongPress={props.onKillAndArchive ? handleKillAndArchivePress : undefined}
                                                delayLongPress={600}
                                                disabled={isAborting}
                                                style={(p) => ({
                                                    width: 34,
                                                    height: 34,
                                                    borderRadius: 17,
                                                    backgroundColor: theme.colors.button.primary.background,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    opacity: p.pressed ? 0.6 : 1,
                                                })}
                                            >
                                                {isAborting ? (
                                                    <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                                                ) : (
                                                    <View style={{ width: 12, height: 12, backgroundColor: theme.colors.button.primary.tint, borderRadius: 2 }} />
                                                )}
                                            </Pressable>
                                        </Shaker>
                                    )}

                                    {/* Send/Voice button — always available */}
                                    <View
                                        style={[
                                            styles.sendButton,
                                            (hasText || hasPendingAttachments || props.isSending || (props.onMicPress && !props.isMicActive) || (props.isMicActive && props.isMicContinuous))
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
                                                // @ts-ignore
                                                WebkitTouchCallout: 'none',
                                                userSelect: 'none',
                                            })}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            onPress={() => {
                                                hapticsLight();
                                                if (props.isMicActive && props.isMicContinuous) {
                                                    // Continuous voice recording — stop it
                                                    props.onMicPress?.();
                                                } else if (hasText || hasPendingAttachments) {
                                                    props.onSend();
                                                } else {
                                                    props.onMicPress?.();
                                                }
                                            }}
                                            onLongPress={() => {
                                                if (!hasText && !hasPendingAttachments && !(props.isMicActive && props.isMicContinuous)) {
                                                    hapticsLight();
                                                    props.onMicLongPress?.();
                                                }
                                            }}
                                            delayLongPress={400}
                                            disabled={props.isSendDisabled || props.isSending || (!hasText && !hasPendingAttachments && !props.onMicPress)}
                                        >
                                            {props.isSending ? (
                                                <ActivityIndicator
                                                    size="small"
                                                    color={theme.colors.button.primary.tint}
                                                />
                                            ) : props.isMicActive && props.isMicContinuous ? (
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    backgroundColor: theme.colors.button.primary.tint,
                                                    borderRadius: 2,
                                                }} />
                                            ) : (hasText || hasPendingAttachments) ? (
                                                <Octicons
                                                    name="arrow-up"
                                                    size={20}
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
                                                        width: 28,
                                                        height: 28,
                                                    }}
                                                    tintColor={theme.colors.button.primary.tint}
                                                />
                                            ) : (
                                                <Octicons
                                                    name="arrow-up"
                                                    size={20}
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
                            </View>
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}));

// Inline git status badge for gear overlay (shows +N -N counts)
function GitStatusBadgeInline({ sessionId }: { sessionId: string }) {
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;
    const { theme } = useUnistyles();

    if (!gitStatus || gitStatus.lastUpdatedAt === 0) return null;
    const hasChanges = gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0;
    if (!hasChanges) return null;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {gitStatus.unstagedLinesAdded > 0 && (
                <Text style={{ fontSize: 12, color: theme.colors.gitAddedText, fontWeight: '600' }}>
                    +{gitStatus.unstagedLinesAdded}
                </Text>
            )}
            {gitStatus.unstagedLinesRemoved > 0 && (
                <Text style={{ fontSize: 12, color: theme.colors.gitRemovedText, fontWeight: '600' }}>
                    -{gitStatus.unstagedLinesRemoved}
                </Text>
            )}
        </View>
    );
}
