import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, Text, ActivityIndicator, Pressable } from 'react-native';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import type { AttachmentGalleryPresentation } from '@/utils/attachmentGalleryLayout';
import { generateThumbhash } from '@/utils/thumbhash';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { Theme } from '@/theme';
import { t } from '@/text';
import type { ComposerAutocompleteSuggestion } from './autocomplete/types';
import { supportsDesktopComposerModeSelector } from '@/utils/desktopNavigationLayout';
import {
    SessionComposerModeSelector,
    type SessionComposerModeSelectorConfig,
} from './SessionComposerModeSelector';
import {
    SessionComposerPermissionSelector,
    type SessionComposerPermissionSelectorConfig,
} from './SessionComposerPermissionSelector';
import {
    SessionComposerDirectorySelector,
    type SessionComposerDirectorySelectorConfig,
} from './SessionComposerDirectorySelector';
import { resolveComposerPrimaryAction } from './composerPrimaryAction';
import { useComposerAbortConfirmation } from '@/hooks/useComposerAbortConfirmation';

interface MessageComposerProps {
    // Drives layout differences between the home compose box and the in-session
    // input. `home` hides the session-only toolbar affordances (agent/abort/git)
    // and the status/context rows; `session` renders the full set.
    mode: 'home' | 'session';
    // `initialValue` seeds the uncontrolled textarea once; keystrokes never
    // round-trip back into it via React, which is what keeps fast typing/
    // deletion crisp. The parent reads the live text via the imperative ref.
    initialValue: string;
    placeholder: string;
    // Fires on every keystroke so the parent can sync derived state (drafts,
    // hasText) — typically wrapped in startTransition / debounce by the caller.
    onChangeText?: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
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
            opencode?: boolean | null;
        };
    };
    autocompletePrefixes?: string[];
    autocompleteSuggestions?: (query: string) => Promise<ComposerAutocompleteSuggestion[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: 'ask' | 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    blockSend?: boolean;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    zenMode?: boolean;
    /** Optional controls rendered at the leading edge of the composer's footer. */
    leadingControls?: React.ReactNode;
    /** Running-session model/effort controls. Picks affect future messages only. */
    modeSelector?: SessionComposerModeSelectorConfig;
    /** Friendly per-turn permission controls. Picks affect future messages only. */
    permissionSelector?: SessionComposerPermissionSelectorConfig;
    /** Working directory for the next and subsequent messages. */
    directorySelector?: SessionComposerDirectorySelectorConfig;
    /** Image attachments waiting to be sent (expImageUpload feature). */
    selectedImages?: AttachmentPreview[];
    selectedImagesPresentation?: AttachmentGalleryPresentation;
    onPickImages?: () => void;
    onRemoveImage?: (id: string) => void;
    onAddImages?: (images: AttachmentPreview[]) => void;
    /** Captures the full desktop immediately when the camera button is pressed. */
    onCaptureScreenshot?: () => void;
    /**
     * True while a screenshot capture RPC is in flight (1-5s round-trip). When
     * set, the camera button swaps its icon for a spinner so the tap isn't a
     * silent wait with no feedback.
     */
    screenshotCapturing?: boolean;
}

const MAX_CONTEXT_SIZE = 190000;

// Stable fallbacks so home mode (which has no autocomplete) can omit these
// props without handing MessageComposer.memo a fresh ref on every render.
const EMPTY_AUTOCOMPLETE_PREFIXES: string[] = [];
const EMPTY_AUTOCOMPLETE_SUGGESTIONS = async () => [];

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
        // In light mode input.background equals the screen background, so a faint
        // hairline divider makes the box nearly invisible — use a stronger grey
        // border there. Dark mode already reads as a box via fill contrast.
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        borderWidth: 1,
        borderColor: theme.dark ? theme.colors.divider : '#C9C9CE',
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
    actionButtonsRight: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
    sendButton: {
        width: Platform.select({ web: 32, default: 40 }),
        height: Platform.select({ web: 32, default: 40 }),
        borderRadius: Platform.select({ web: 16, default: 20 }),
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
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
    abortConfirmationLabel: {
        color: theme.colors.button.primary.tint,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default('semiBold'),
    },
    imagePickerButton: {
        width: 40,
        height: 40,
        borderRadius: Platform.select({ default: 20, android: 22 }),
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 4,
        zIndex: 2,
    },
    imagePickerButtonActive: {
        backgroundColor: theme.colors.surfaceHigh,
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

// Stable sub-trees extracted from MessageComposer so they don't reconcile when
// the input's keystroke-derived state (hasText / inputState) flips. Their
// props are derived from session metadata, not from the textarea content,
// so memo skips re-render on typing entirely.

type StatusRowProps = {
    connectionStatus?: MessageComposerProps['connectionStatus'];
    contextWarning: { text: string; color: string } | null;
};

const AgentInputStatusRow = React.memo(function AgentInputStatusRow(p: StatusRowProps) {
    const { theme } = useUnistyles();
    if (!p.connectionStatus && !p.contextWarning) {
        return null;
    }
    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingBottom: 4,
            minHeight: 20,
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 11 }}>
                {p.connectionStatus && (
                    <>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <StatusDot
                                color={p.connectionStatus.dotColor}
                                isPulsing={p.connectionStatus.isPulsing}
                                size={6}
                            />
                            <Text style={{
                                fontSize: 11,
                                color: p.connectionStatus.color,
                                ...Typography.default()
                            }}>
                                {p.connectionStatus.text}
                            </Text>
                        </View>
                        {p.connectionStatus.cliStatus && (
                            <>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.claude ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        {p.connectionStatus.cliStatus.claude ? '✓' : '✗'}
                                    </Text>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.claude ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        claude
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.codex ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        {p.connectionStatus.cliStatus.codex ? '✓' : '✗'}
                                    </Text>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.codex ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        codex
                                    </Text>
                                </View>
                                {p.connectionStatus.cliStatus.gemini !== undefined && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.gemini ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            {p.connectionStatus.cliStatus.gemini ? '✓' : '✗'}
                                        </Text>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.gemini ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            gemini
                                        </Text>
                                    </View>
                                )}
                                {p.connectionStatus.cliStatus.opencode !== undefined && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.opencode ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            {p.connectionStatus.cliStatus.opencode ? '✓' : '✗'}
                                        </Text>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.opencode ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            opencode
                                        </Text>
                                    </View>
                                )}
                            </>
                        )}
                    </>
                )}
                {p.contextWarning && (
                    <Text style={{
                        fontSize: 11,
                        color: p.contextWarning.color,
                        marginLeft: p.connectionStatus ? 8 : 0,
                        ...Typography.default()
                    }}>
                        {p.connectionStatus ? '• ' : ''}{p.contextWarning.text}
                    </Text>
                )}
            </View>
        </View>
    );
});

type ContextChipsProps = {
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
};

const AgentInputContextChips = React.memo(function AgentInputContextChips(p: ContextChipsProps) {
    const { theme } = useUnistyles();
    if (p.machineName === undefined && !p.currentPath) {
        return null;
    }
    return (
        <View style={{
            backgroundColor: theme.colors.surfacePressed,
            borderRadius: 12,
            padding: 8,
            marginBottom: 8,
            gap: 4,
        }}>
            {p.machineName !== undefined && p.onMachineClick && (
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        p.onMachineClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="desktop-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.machineName === null ? t('agentInput.noMachinesAvailable') : p.machineName}
                    </Text>
                </Pressable>
            )}
            {p.currentPath && p.onPathClick && (
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        p.onPathClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="folder-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.currentPath}
                    </Text>
                </Pressable>
            )}
        </View>
    );
});

export const MessageComposer = React.memo(React.forwardRef<MultiTextInputHandle, MessageComposerProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth } = useWindowDimensions();
    const [directoryInvalid, setDirectoryInvalid] = React.useState(false);
    const isSendBlocked = (props.blockSend ?? false)
        || directoryInvalid
        || Boolean(props.directorySelector?.switching);
    const isSession = props.mode === 'session';
    const autocompletePrefixes = props.autocompletePrefixes ?? EMPTY_AUTOCOMPLETE_PREFIXES;
    const autocompleteSuggestions = props.autocompleteSuggestions ?? EMPTY_AUTOCOMPLETE_SUGGESTIONS;

    // `hasText` drives only the send-button appearance/enabled state. It's
    // updated via startTransition from the keystroke handler so a busy reducer
    // never blocks the next character from landing in the textarea.
    const [hasText, setHasText] = React.useState(() => props.initialValue.trim().length > 0);
    const hasImages = (props.selectedImages?.length ?? 0) > 0;
    const hasPayload = hasText || hasImages;
    const primaryAction = resolveComposerPrimaryAction({
        mode: props.mode,
        showAbortButton: props.showAbortButton ?? false,
        hasAbortHandler: Boolean(props.onAbort),
        hasPayload,
    });
    const isAbortAction = primaryAction === 'abort';
    const canPressSendButton = !props.isSending
        && !props.isSendDisabled
        && !isSendBlocked
        && hasPayload;

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, props.alwaysShowContextSize ?? false, theme)
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    const handleCaptureScreenshot = React.useCallback(() => {
        if (props.screenshotCapturing) return;
        hapticsLight();
        props.onCaptureScreenshot?.();
    }, [props.onCaptureScreenshot, props.screenshotCapturing]);

    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const sendBlockShakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Web paste/drag — intercept image pastes and file drops for the
    // attachment feature. Both handlers funnel through props.onAddImages.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.onAddImages) return;

        const handlePaste = async (e: ClipboardEvent) => {
            // Only handle pastes targeted at a focused text-editable element.
            // The listener is attached to document, so without this guard a
            // paste in the URL bar, another modal, or any focused-elsewhere
            // input would steal images intended for somewhere else.
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget) return;

            const { getImagesFromClipboard, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromClipboard(e);
            if (!files.length) return;
            e.preventDefault();
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                props.onAddImages!(previews.map((p) => ({
                    ...p,
                    id: `paste_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        // dragover must call preventDefault for drop to fire; we gate on
        // `types.includes('Files')` so we don't hijack drag-text/HTML in the
        // rest of the app.
        const isFileDrag = (e: DragEvent) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            // DataTransferItemList vs DOMStringList — both expose .includes-ish.
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
            return false;
        };

        const handleDragOver = (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            const { getImagesFromDrop, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromDrop(e);
            if (!files.length) return;
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                props.onAddImages!(previews.map((p) => ({
                    ...p,
                    id: `drop_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        document.addEventListener('paste', handlePaste as any);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [props.onAddImages]);

    // Autocomplete state — text + selection. Updated via startTransition so
    // typing renders the character immediately and the autocomplete pipeline
    // catches up on the next idle frame instead of blocking input.
    const [inputState, setInputState] = React.useState<TextInputState>(() => ({
        text: props.initialValue,
        selection: { start: props.initialValue.length, end: props.initialValue.length }
    }));

    const onChangeTextProp = props.onChangeText;
    const handleTextChange = React.useCallback((text: string) => {
        React.startTransition(() => {
            setHasText(text.trim().length > 0);
        });
        onChangeTextProp?.(text);
    }, [onChangeTextProp]);

    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        React.startTransition(() => {
            setInputState(newState);
        });
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.insertText ?? suggestion.text,
            autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, autocompletePrefixes]);

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

    const {
        confirm: confirmAbortShortcut,
        handleEscape: handleAbortEscape,
        isArmed: isAbortConfirmationArmed,
    } = useComposerAbortConfirmation({
        enabled: Platform.OS === 'web'
            && Boolean(props.showAbortButton)
            && Boolean(props.onAbort)
            && !isAborting,
        onConfirm: handleAbortPress,
    });

    const handleBlockedSendAttempt = React.useCallback(() => {
        if (!isSendBlocked || !hasText || props.isSending) return;
        hapticsError();
        sendBlockShakerRef.current?.shake();
    }, [hasText, isSendBlocked, props.isSending]);

    const handleSendPress = React.useCallback(() => {
        if (isSendBlocked) {
            handleBlockedSendAttempt();
            return;
        }
        if (props.isSendDisabled || props.isSending) return;

        hapticsLight();
        // Live read avoids stalling behind the transitioned `hasText`.
        const liveHasText = (inputRef.current?.getText() ?? '').trim().length > 0;
        if (liveHasText || hasImages) {
            props.onSend();
        }
    }, [handleBlockedSendAttempt, hasImages, isSendBlocked, props.isSendDisabled, props.isSending, props.onSend]);

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

        // On PC, Escape uses a recoverable two-step confirmation. Native keeps
        // the existing one-press hardware-keyboard behavior.
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            if (Platform.OS === 'web') {
                return handleAbortEscape();
            }
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // On mobile web (touch devices), Enter should insert a newline since
            // there's no Shift key available. Users send via the send button instead.
            // Use pointer:coarse media query instead of ontouchstart/maxTouchPoints
            // to avoid false positives on Windows touch-screen laptops with keyboards.
            const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
                // Read live text from the textarea — `hasText` is debounced via
                // startTransition and would lag behind a quick type-then-Enter.
                const liveText = inputRef.current?.getText() ?? '';
                if (liveText.trim()) {
                    if (isSendBlocked) {
                        handleBlockedSendAttempt();
                    } else if (!props.isSendDisabled) {
                        props.onSend();
                    }
                    return true; // Key was handled
                }
            }
        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortEscape, handleAbortPress, agentInputEnterToSend, props.onSend, isSendBlocked, handleBlockedSendAttempt, props.isSendDisabled]);




    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 12 : 8 }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]} testID="message-composer-content">
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

                {isSession && (
                    <>
                        <AgentInputStatusRow
                            connectionStatus={props.connectionStatus}
                            contextWarning={contextWarning}
                        />

                        <AgentInputContextChips
                            machineName={props.machineName}
                            onMachineClick={props.onMachineClick}
                            currentPath={props.currentPath}
                            onPathClick={props.onPathClick}
                        />
                    </>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <Shaker ref={sendBlockShakerRef}>
                <View style={styles.unifiedPanel}>
                    {/* Attachment preview strip */}
                    {props.selectedImages && props.selectedImages.length > 0 && (
                        <AgentInputAttachmentStrip
                            images={props.selectedImages}
                            onRemove={props.onRemoveImage ?? (() => {})}
                            presentation={props.selectedImagesPresentation}
                        />
                    )}
                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            testID={isSession ? 'session-message-input' : 'new-session-message-input'}
                            ref={inputRef}
                            defaultValue={props.initialValue}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={handleTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={Platform.OS === 'web' ? 480 : 120}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                            {/* Row 1: Profile (FIRST), Agent, Git Status */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                {props.zenMode && <View style={{ flex: 1 }} />}
                                {!props.zenMode && <View style={styles.actionButtonsLeft}>

                                {props.leadingControls}

                                {isSession && props.directorySelector && supportsDesktopComposerModeSelector({
                                    isWeb: Platform.OS === 'web',
                                    windowWidth: screenWidth,
                                }) ? (
                                    <SessionComposerDirectorySelector
                                        {...props.directorySelector}
                                        onInvalidStateChange={setDirectoryInvalid}
                                    />
                                ) : null}

                                {/* Agent selector button (session only) */}
                                {isSession && props.agentType && props.onAgentClick && (
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
                                            {props.agentType === 'claude'
                                                ? t('agentInput.agent.claude')
                                                : props.agentType === 'codex'
                                                    ? t('agentInput.agent.codex')
                                                    : props.agentType === 'opencode'
                                                        ? 'OpenCode'
                                                    : props.agentType === 'openclaw'
                                                        ? t('agentInput.agent.openclaw')
                                                        : t('agentInput.agent.gemini')}
                                        </Text>
                                    </Pressable>
                                )}

                                {/* Git Status Badge (session only) */}
                                {isSession && (
                                    <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} />
                                )}

                                </View>}

                                {/* Right cluster: image picker + send (image sits at far right, next to send) */}
                                <View style={styles.actionButtonsRight}>
                                {/* Image picker button (expImageUpload) */}
                                {props.onPickImages && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={t('imageUpload.chooseSourceTitle')}
                                        onPress={() => {
                                            hapticsLight();
                                            props.onPickImages?.();
                                        }}
                                        hitSlop={8}
                                        style={(p) => [
                                            styles.imagePickerButton,
                                            (props.selectedImages?.length ?? 0) > 0 && styles.imagePickerButtonActive,
                                            p.pressed && { opacity: 0.7 },
                                        ]}
                                    >
                                        <Ionicons
                                            name="attach"
                                            size={18}
                                            color={(props.selectedImages?.length ?? 0) > 0
                                                ? theme.colors.radio.active
                                                : theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}

                                {/* Full-desktop screenshot button */}
                                {props.onCaptureScreenshot && (
                                    <Pressable
                                        accessibilityLabel={t('components.messageComposer.screenshot')}
                                        onPress={handleCaptureScreenshot}
                                        disabled={props.screenshotCapturing}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: props.screenshotCapturing ? 0.6 : (p.pressed ? 0.7 : 1),
                                        })}
                                    >
                                        {props.screenshotCapturing ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.secondary.tint}
                                            />
                                        ) : (
                                            <Ionicons
                                                name="camera-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                        )}
                                    </Pressable>
                                )}

                                {/* Inline execution controls are desktop affordances. Narrow Web and native
                                    layouts keep the compact composer and use the existing session menu. */}
                                {isSession && props.permissionSelector && supportsDesktopComposerModeSelector({
                                    isWeb: Platform.OS === 'web',
                                    windowWidth: screenWidth,
                                }) ? (
                                    <SessionComposerPermissionSelector {...props.permissionSelector} />
                                ) : null}

                                {isSession && props.modeSelector && supportsDesktopComposerModeSelector({
                                    isWeb: Platform.OS === 'web',
                                    windowWidth: screenWidth,
                                }) ? (
                                    <SessionComposerModeSelector {...props.modeSelector} />
                                ) : null}

                                {/* Primary action: stop while running and empty, send when there is a payload. */}
                                <Shaker
                                    ref={shakerRef}
                                    style={[
                                        styles.sendButton,
                                        (isAbortAction || isAbortConfirmationArmed || canPressSendButton || props.isSending)
                                            ? styles.sendButtonActive
                                            : styles.sendButtonInactive
                                    ]}
                                >
                                    <Pressable
                                        testID={(isAbortAction || isAbortConfirmationArmed)
                                            ? 'message-composer-abort-button'
                                            : 'message-composer-send-button'}
                                        accessibilityRole="button"
                                        accessibilityLabel={(isAbortAction || isAbortConfirmationArmed)
                                            ? t('keyboardShortcuts.stopRunningAgent')
                                            : t('keyboardShortcuts.sendMessage')}
                                        style={(p) => ({
                                            width: '100%',
                                            height: '100%',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                        hitSlop={Platform.OS === 'web'
                                            ? { top: 5, bottom: 10, left: 0, right: 0 }
                                            : { top: 4, bottom: 4, left: 4, right: 4 }}
                                        onPress={isAbortConfirmationArmed
                                            ? confirmAbortShortcut
                                            : isAbortAction
                                                ? handleAbortPress
                                                : handleSendPress}
                                        disabled={(isAbortAction || isAbortConfirmationArmed)
                                            ? isAborting
                                            : !canPressSendButton}
                                    >
                                        {((isAbortAction || isAbortConfirmationArmed) && isAborting)
                                            || (!isAbortAction && !isAbortConfirmationArmed && props.isSending) ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : isAbortConfirmationArmed ? (
                                            <Text style={styles.abortConfirmationLabel}>Esc</Text>
                                        ) : isAbortAction ? (
                                            <Octicons
                                                name="square-fill"
                                                size={12}
                                                color={theme.colors.button.primary.tint}
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
                                </Shaker>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>
                </Shaker>
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
