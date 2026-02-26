import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/AgentInput';
import { MultiTextInputHandle } from '@/components/MultiTextInput';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { DuplicateSheet } from '@/components/DuplicateSheet';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { EmptyMessages } from '@/components/EmptyMessages';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort, machineGetClaudeSessionUserMessages, machineDuplicateClaudeSession, machineSpawnNewSession, machineGetGeminiSessionUserMessages, machineDuplicateGeminiSession, machineGetCodexSessionUserMessages, machineDuplicateCodexSession, type UserMessageWithUuid } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionUsage, useSetting } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { formatPathRelativeToHome, generateCopyTitle, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { log } from '@/log';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

const SILENT_REFRESH_INDICATOR_DELAY_MS = 3000;
const SILENT_REFRESH_FAILED_TIMEOUT_MS = 12000;

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();

    // Track if we've confirmed the session doesn't exist after data loads
    const [sessionNotFound, setSessionNotFound] = React.useState(false);

    // When session appears, reset the not found state
    React.useEffect(() => {
        if (session) {
            setSessionNotFound(false);
        }
    }, [session]);

    // When session doesn't exist, refresh sessions and check again
    React.useEffect(() => {
        if (!isDataReady || session || sessionNotFound) {
            return;
        }

        let cancelled = false;

        // Refresh sessions and then check if session exists
        sync.refreshSessions()
            .then(() => {
                if (cancelled) return;
                // After refresh, check if session exists in storage
                if (!storage.getState().sessions[sessionId]) {
                    setSessionNotFound(true);
                }
            })
            .catch(() => {
                // On error, mark as not found to avoid infinite loading
                if (!cancelled) {
                    setSessionNotFound(true);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [isDataReady, session, sessionId, sessionNotFound]);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session) {
            // Show deleted message only if we've confirmed session doesn't exist
            // Otherwise show empty header while waiting for data
            return {
                title: sessionNotFound ? t('errors.sessionDeleted') : '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        const isConnected = session.presence === 'online';
        return {
            title: getSessionName(session),
            subtitle: session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined,
            avatarId: getSessionAvatarId(session),
            onAvatarPress: () => router.push(`/session/${sessionId}/info`),
            isConnected: isConnected,
            flavor: session.metadata?.flavor || null,
            sessionIcon: session.metadata?.sessionIcon || null,
            tintColor: isConnected ? '#000' : '#8E8E93'
        };
    }, [session, isDataReady, sessionId, router, sessionNotFound]);

    return (
        <>
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        {...headerProps}
                        onBackPress={() => router.back()}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight + (!isTablet && realtimeStatus !== 'disconnected' ? 48 : 0) : 0 }}>
                {!isDataReady ? (
                    // Loading state - initial data not ready
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session && !sessionNotFound ? (
                    // Loading state - waiting for session data to arrive
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session && sessionNotFound ? (
                    // Deleted state - confirmed session doesn't exist
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : session ? (
                    // Normal session view
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} />
                ) : null}
            </View>
        </>
    );
});


function SessionViewLoaded({ sessionId, session }: { sessionId: string, session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const [message, setMessage] = React.useState('');
    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded, fetchVersion } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    // Get permission mode from session object, default to 'default'
    const permissionMode = session.permissionMode || 'default';
    // Get model mode from session object. "default" means use CLI/profile configured model.
    const modelMode = session.modelMode || 'default';
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const [silentRefreshTrackingKey, setSilentRefreshTrackingKey] = React.useState(0);
    const [silentRefreshPhase, setSilentRefreshPhase] = React.useState<'idle' | 'refreshing' | 'failed'>('idle');
    const latestMessageSnapshotRef = React.useRef({ isLoaded, messages, fetchVersion });
    latestMessageSnapshotRef.current = { isLoaded, messages, fetchVersion };
    const silentRefreshBaselineRef = React.useRef<{ isLoaded: boolean; messagesRef: typeof messages; fetchVersion: number } | null>(null);

    const startSilentRefreshTracking = React.useCallback(() => {
        const snapshot = latestMessageSnapshotRef.current;
        if (!snapshot.isLoaded) {
            setSilentRefreshTrackingKey(0);
            setSilentRefreshPhase('idle');
            silentRefreshBaselineRef.current = null;
            return;
        }

        silentRefreshBaselineRef.current = {
            isLoaded: snapshot.isLoaded,
            messagesRef: snapshot.messages,
            fetchVersion: snapshot.fetchVersion,
        };
        setSilentRefreshTrackingKey((k) => k + 1);
        setSilentRefreshPhase('idle');
    }, []);

    const isTracking = silentRefreshTrackingKey > 0;

    React.useEffect(() => {
        if (!isTracking) {
            return;
        }
        const baseline = silentRefreshBaselineRef.current;
        if (!baseline) {
            return;
        }
        if (messages !== baseline.messagesRef || isLoaded !== baseline.isLoaded || fetchVersion !== baseline.fetchVersion) {
            setSilentRefreshTrackingKey(0);
            setSilentRefreshPhase('idle');
            silentRefreshBaselineRef.current = null;
        }
    }, [isTracking, isLoaded, messages, fetchVersion]);

    React.useEffect(() => {
        if (!isTracking) {
            return;
        }
        const refreshingTimer = setTimeout(() => {
            setSilentRefreshPhase((prev) => (prev === 'idle' ? 'refreshing' : prev));
        }, SILENT_REFRESH_INDICATOR_DELAY_MS);
        const failedTimer = setTimeout(() => {
            setSilentRefreshPhase((prev) => {
                if (prev === 'idle' || prev === 'refreshing') {
                    return 'failed';
                }
                return prev;
            });
        }, SILENT_REFRESH_FAILED_TIMEOUT_MS);
        return () => {
            clearTimeout(refreshingTimer);
            clearTimeout(failedTimer);
        };
    }, [isTracking, silentRefreshTrackingKey]);

    const handleRetryStatusRefresh = React.useCallback(() => {
        startSilentRefreshTracking();
        setSilentRefreshPhase('refreshing');
        void sync.refreshSessions().catch(() => {
            // Keep current phase and rely on timeout-based feedback.
        });
    }, [startSilentRefreshTracking]);

    const isRefreshingStatus = silentRefreshPhase === 'refreshing' || sessionStatus.state === 'syncing';

    const inputConnectionStatus = React.useMemo(() => {
        if (silentRefreshPhase === 'failed') {
            return {
                text: t('status.refreshFailed'),
                color: theme.colors.status.error,
                dotColor: theme.colors.status.error,
                isPulsing: false,
                onPress: handleRetryStatusRefresh
            };
        }
        if (isRefreshingStatus) {
            return {
                text: t('status.refreshing'),
                color: theme.colors.status.connecting,
                dotColor: theme.colors.status.connecting,
                isPulsing: true
            };
        }
        return {
            text: sessionStatus.statusText,
            color: sessionStatus.statusColor,
            dotColor: sessionStatus.statusDotColor,
            isPulsing: sessionStatus.isPulsing,
            ...(sessionStatus.state === 'permission_required' && { action: 'openPermission' as const }),
        };
    }, [silentRefreshPhase, isRefreshingStatus, sessionStatus, theme.colors.status.connecting, theme.colors.status.error, handleRetryStatusRefresh]);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    // Ref for the input component (used for web auto-focus)
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Handler for filling the input from option selection
    const handleFillInput = React.useCallback(async (text: string, allOptions?: string[]) => {
        const currentMessage = message.trim();
        if (currentMessage) {
            // Skip confirmation if current input is one of the available options
            const isCurrentInputAnOption = allOptions?.includes(currentMessage);
            if (!isCurrentInputAnOption) {
                const confirmed = await Modal.confirm(
                    t('message.confirmOverwriteInput'),
                    t('message.confirmOverwriteInputMessage'),
                    { confirmText: t('common.yes'), cancelText: t('common.cancel') }
                );
                if (!confirmed) return;
            }
        }
        setMessage(text);
        // Auto-focus input on web platform
        if (Platform.OS === 'web') {
            inputRef.current?.focus();
        }
    }, [message]);

    // Image picker hook for handling image attachments
    const {
        images,
        pickFromGallery,
        pickFromCamera,
        addImageFromUri,
        removeImage,
        clearImages,
        canAddMore,
    } = useImagePicker({ maxImages: 4 });
    const [isUploadingImages, setIsUploadingImages] = React.useState(false);
    const [isSending, setIsSending] = React.useState(false);

    // Track failed message for retry with same localId
    const failedMessageRef = React.useRef<{ localId: string; content: string } | null>(null);

    // Duplicate sheet state
    const [duplicateSheetVisible, setDuplicateSheetVisible] = React.useState(false);
    const [duplicateMessages, setDuplicateMessages] = React.useState<UserMessageWithUuid[] | null>(null);
    const [duplicateLoading, setDuplicateLoading] = React.useState(false);
    const [duplicateConfirming, setDuplicateConfirming] = React.useState(false);
    const duplicateProjectIdRef = React.useRef<string | null>(null);

    // Ref for hidden file input (web only)
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // Image picker sheet state
    const [imagePickerSheetVisible, setImagePickerSheetVisible] = React.useState(false);

    // Check if the current session flavor supports images
    const supportsImages = React.useMemo(() => {
        const flavor = session?.metadata?.flavor;
        return flavor === 'claude' || flavor === 'gemini' || flavor === 'codex';
    }, [session?.metadata?.flavor]);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo') => {
        storage.getState().updateSessionPermissionMode(sessionId, mode);
    }, [sessionId]);

    // Function to update model mode
    const updateModelMode = React.useCallback((mode: string) => {
        storage.getState().updateSessionModelMode(sessionId, mode);
    }, [sessionId]);

    // Handle opening the duplicate sheet - loads user messages from the session
    const handleOpenDuplicateSheet = React.useCallback(async () => {
        const flavor = session.metadata?.flavor;
        const claudeSessionId = session.metadata?.claudeSessionId;
        const codexSessionId = session.metadata?.codexSessionId;
        const canDuplicate = Boolean(claudeSessionId || flavor === 'gemini' || codexSessionId);
        if (!machineId || !canDuplicate) {
            Modal.alert(t('common.error'), t('duplicate.notAvailable'));
            return;
        }

        // Blur input to prevent keyboard from re-appearing when the modal closes
        inputRef.current?.blur();

        setDuplicateSheetVisible(true);
        setDuplicateLoading(true);
        setDuplicateMessages(null);

        try {
            if (flavor === 'gemini') {
                const result = await machineGetGeminiSessionUserMessages(machineId, session.id);
                setDuplicateMessages(result.messages);
            } else if (flavor === 'codex' && codexSessionId) {
                const result = await machineGetCodexSessionUserMessages(machineId, codexSessionId);
                setDuplicateMessages(result.messages);
            } else if (claudeSessionId) {
                const result = await machineGetClaudeSessionUserMessages(machineId, claudeSessionId);
                setDuplicateMessages(result.messages);
                duplicateProjectIdRef.current = result.projectId;
            }
        } catch (error) {
            console.error('Failed to load duplicate messages:', error);
            Modal.alert(t('common.error'), t('duplicate.loadFailed'));
            setDuplicateSheetVisible(false);
        } finally {
            setDuplicateLoading(false);
        }
    }, [machineId, session.id, session.metadata?.flavor, session.metadata?.claudeSessionId, session.metadata?.codexSessionId]);

    // Handle selecting a message to duplicate from
    const handleDuplicateSelect = React.useCallback(async (uuid: string) => {
        const flavor = session.metadata?.flavor;
        const claudeSessionId = session.metadata?.claudeSessionId;
        const codexSessionId = session.metadata?.codexSessionId;
        const sessionPath = session.metadata?.path;
        if (!machineId || !sessionPath) return;

        // Start confirming state - keep sheet open with loading button
        setDuplicateConfirming(true);

        try {
            let resumeSessionId: string | undefined;
            let agent: 'claude' | 'gemini' | 'codex' = 'claude';

            if (flavor === 'gemini') {
                const duplicateResult = await machineDuplicateGeminiSession(machineId, session.id, uuid);
                if (!duplicateResult.success || !duplicateResult.newSessionId) {
                    setDuplicateConfirming(false);
                    Modal.alert(t('common.error'), duplicateResult.errorMessage || t('duplicate.failed'));
                    return;
                }
                resumeSessionId = duplicateResult.newSessionId;
                agent = 'gemini';
            } else if (flavor === 'codex' && codexSessionId) {
                const duplicateResult = await machineDuplicateCodexSession(machineId, codexSessionId, uuid);
                if (!duplicateResult.success || !duplicateResult.newFilePath) {
                    setDuplicateConfirming(false);
                    Modal.alert(t('common.error'), duplicateResult.errorMessage || t('duplicate.failed'));
                    return;
                }
                resumeSessionId = duplicateResult.newFilePath;
                agent = 'codex';
            } else if (claudeSessionId) {
                const duplicateResult = await machineDuplicateClaudeSession(machineId, claudeSessionId, uuid);
                if (!duplicateResult.success || !duplicateResult.newSessionId) {
                    setDuplicateConfirming(false);
                    Modal.alert(t('common.error'), duplicateResult.errorMessage || t('duplicate.failed'));
                    return;
                }
                resumeSessionId = duplicateResult.newSessionId;
                agent = 'claude';
            } else {
                setDuplicateConfirming(false);
                return;
            }

            // Step 2: Spawn a new Happy session that resumes the forked Claude session
            const newSessionTitle = generateCopyTitle(getSessionName(session));

            const spawnResult = await machineSpawnNewSession({
                machineId,
                directory: sessionPath,
                agent,
                resumeSessionId,
                sessionTitle: newSessionTitle,
                skipForkSession: true,
            });

            if (spawnResult.type === 'success' && spawnResult.sessionId) {
                // Close the sheet and navigate to the new Happy session
                setDuplicateSheetVisible(false);
                setDuplicateConfirming(false);
                router.replace(`/session/${spawnResult.sessionId}`);
            } else if (spawnResult.type === 'error') {
                setDuplicateConfirming(false);
                Modal.alert(t('common.error'), spawnResult.errorMessage || t('duplicate.failed'));
            }
        } catch (error) {
            console.error('Failed to duplicate session:', error);
            setDuplicateConfirming(false);
            Modal.alert(t('common.error'), t('duplicate.failed'));
        }
    }, [machineId, session.id, session.metadata?.flavor, session.metadata?.claudeSessionId, session.metadata?.codexSessionId, session.metadata?.path, router]);

    // Handle closing the duplicate sheet (prevent closing while confirming)
    const handleCloseDuplicateSheet = React.useCallback(() => {
        if (!duplicateConfirming) {
            setDuplicateSheetVisible(false);
        }
    }, [duplicateConfirming]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);


    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') {
            return; // Prevent actions during transitions
        }
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                await startRealtimeSession(sessionId, initialPrompt);
                tracking?.capture('voice_session_started', { sessionId });
            } catch (error) {
                console.error('Failed to start realtime session:', error);
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
                tracking?.capture('voice_session_error', { error: error instanceof Error ? error.message : 'Unknown error' });
            }
        } else if (realtimeStatus === 'connected') {
            // On web/desktop, stop session from mic button; on mobile, use the status bar
            if (Platform.OS === 'web') {
                await stopRealtimeSession();
                tracking?.capture('voice_session_stopped');
                voiceHooks.onVoiceStopped();
            }
        }
    }, [realtimeStatus, sessionId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(() => ({
        onMicPress: handleMicrophonePress,
        isMicActive: realtimeStatus === 'connected' || realtimeStatus === 'connecting'
    }), [handleMicrophonePress, realtimeStatus]);

    // Handle image button press - platform-specific behavior
    const handleImageButtonPress = React.useCallback(() => {
        if (Platform.OS === 'web') {
            // Web: directly open file picker
            fileInputRef.current?.click();
        } else {
            // Native: show action sheet with camera and gallery options
            setImagePickerSheetVisible(true);
        }
    }, []);

    // Image picker sheet menu items
    const imagePickerMenuItems: ActionMenuItem[] = React.useMemo(() => [
        { label: t('session.takePhoto'), onPress: pickFromCamera },
        { label: t('session.chooseFromLibrary'), onPress: pickFromGallery },
    ], [pickFromCamera, pickFromGallery]);

    // Handle file input change (web only)
    const handleFileInputChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        Array.from(files).forEach(file => {
            if (file.type.startsWith('image/')) {
                const url = URL.createObjectURL(file);
                addImageFromUri(url, file.type);
            }
        });

        // Reset input so same file can be selected again
        event.target.value = '';
    }, [addImageFromUri]);

    // Handle paste event for images (both web and native through input)
    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        if (!canAddMore || !supportsImages) return;

        const items = event.clipboardData?.items;
        if (!items) return;

        for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
                event.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const url = URL.createObjectURL(file);
                    await addImageFromUri(url, file.type);
                }
                break;
            }
        }
    }, [canAddMore, supportsImages, addImageFromUri]);

    // Handle image drop (web only) - passed to AgentInput
    const handleImageDrop = React.useCallback(async (files: File[]) => {
        if (!canAddMore || !supportsImages) return;

        for (const file of files) {
            if (file.type.startsWith('image/') && canAddMore) {
                const url = URL.createObjectURL(file);
                await addImageFromUri(url, file.type);
            }
        }
    }, [canAddMore, supportsImages, addImageFromUri]);

    // Handle loading more older messages when scrolling to top
    const handleLoadMore = React.useCallback(() => {
        return sync.fetchOlderMessages(sessionId);
    }, [sessionId]);

    // Trigger refresh whenever this session screen gets focus.
    useFocusEffect(
        React.useCallback(() => {
            sync.onSessionVisible(sessionId, true);
            startSilentRefreshTracking();
            void sync.refreshSessions().catch(() => {
                // Silent refresh indicator handles delayed feedback if status stays stale.
            });
            gitStatusSync.invalidate(sessionId);
        }, [sessionId, startSilentRefreshTracking])
    );

    // Add paste event listener for images (web only)
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const pasteListener = (e: Event) => handlePaste(e as ClipboardEvent);
        document.addEventListener('paste', pasteListener);

        return () => {
            document.removeEventListener('paste', pasteListener);
        };
    }, [handlePaste]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} onFillInput={handleFillInput} onLoadMore={handleLoadMore} />
                )}
            </Deferred>
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    const input = (
        <AgentInput
            ref={inputRef}
            placeholder={t('session.inputPlaceholder')}
            value={message}
            onChangeText={setMessage}
            sessionId={sessionId}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            modelMode={modelMode as any}
            onModelModeChange={updateModelMode as any}
            metadata={session.metadata}
            connectionStatus={inputConnectionStatus}
            onSend={async (textSnapshot) => {
                const messageToSend = (textSnapshot ?? message).trim();
                if (messageToSend || images.length > 0) {
                    const socketStatus = storage.getState().socketStatus;
                    log.log(`[SEND_DEBUG][UI] tap_send sid=${sessionId} hasText=${messageToSend.length > 0} images=${images.length} isSending=${isSending} socket=${socketStatus}`);

                    // Handle /duplicate command locally
                    if (messageToSend.toLowerCase() === '/duplicate') {
                        setMessage('');
                        clearDraft();
                        handleOpenDuplicateSheet();
                        return;
                    }

                    const imagesToSend = images.length > 0 ? [...images] : undefined;
                    const contentForRetry = messageToSend + JSON.stringify(imagesToSend || []);

                    // Check if this is a retry of the same content
                    const existingLocalId = failedMessageRef.current?.content === contentForRetry
                        ? failedMessageRef.current.localId
                        : undefined;

                    // Set sending state
                    setIsSending(true);
                    if (imagesToSend) {
                        setIsUploadingImages(true);
                    }

                    try {
                        const result = await sync.sendMessage(sessionId, messageToSend, undefined, imagesToSend, existingLocalId);
                        log.log(`[SEND_DEBUG][UI] send_result sid=${sessionId} success=${result.success} localId=${result.localId} error=${result.error || 'none'}`);

                        if (result.success) {
                            // Clear failed message record and input on success
                            failedMessageRef.current = null;
                            setMessage('');
                            clearDraft();
                            clearImages();
                            trackMessageSent();
                        } else {
                            // On failure, record localId and content for retry
                            failedMessageRef.current = { localId: result.localId, content: contentForRetry };
                            log.log(`[SEND_DEBUG][UI] record_retry sid=${sessionId} localId=${result.localId}`);
                        }
                    } finally {
                        setIsSending(false);
                        setIsUploadingImages(false);
                    }
                }
            }}
            isSending={isSending}
            onMicPress={micButtonState.onMicPress}
            isMicActive={micButtonState.isMicActive}
            onAbort={() => sessionAbort(sessionId)}
            showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
            onFileViewerPress={() => router.push(`/session/${sessionId}/files`)}
            // Autocomplete configuration
            autocompletePrefixes={['@', '/']}
            autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
            usageData={sessionUsage ? {
                inputTokens: sessionUsage.inputTokens,
                outputTokens: sessionUsage.outputTokens,
                cacheCreation: sessionUsage.cacheCreation,
                cacheRead: sessionUsage.cacheRead,
                contextSize: sessionUsage.contextSize,
                contextWindowSize: sessionUsage.contextWindowSize,
            } : session.latestUsage ? {
                inputTokens: session.latestUsage.inputTokens,
                outputTokens: session.latestUsage.outputTokens,
                cacheCreation: session.latestUsage.cacheCreation,
                cacheRead: session.latestUsage.cacheRead,
                contextSize: session.latestUsage.contextSize,
                contextWindowSize: session.latestUsage.contextWindowSize,
            } : undefined}
            alwaysShowContextSize={alwaysShowContextSize}
            images={images}
            onImagesChange={(newImages) => {
                // Handle image removal by finding removed index
                // Since useImagePicker manages state, we call removeImage for each removed image
                const currentUris = new Set(newImages.map(img => img.uri));
                images.forEach((img, index) => {
                    if (!currentUris.has(img.uri)) {
                        removeImage(index);
                    }
                });
            }}
            onImageButtonPress={handleImageButtonPress}
            supportsImages={supportsImages}
            isUploadingImages={isUploadingImages}
            onImageDrop={handleImageDrop}
        />
    );


    return (
        <>
            {/* Hidden file input for web image upload */}
            {Platform.OS === 'web' && (
                <input
                    ref={fileInputRef as any}
                    type="file"
                    accept="image/jpeg,image/png"
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange as any}
                />
            )}


            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 32 : 0) }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }

            {/* Duplicate Sheet */}
            <DuplicateSheet
                visible={duplicateSheetVisible}
                messages={duplicateMessages}
                loading={duplicateLoading}
                confirming={duplicateConfirming}
                onClose={handleCloseDuplicateSheet}
                onSelect={handleDuplicateSelect}
            />

            {/* Image Picker Sheet */}
            <ActionMenuModal
                visible={imagePickerSheetVisible}
                items={imagePickerMenuItems}
                onClose={() => setImagePickerSheetVisible(false)}
                deferItemPress
            />
        </>
    )
}
