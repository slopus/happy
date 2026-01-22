import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/AgentInput';
import { PendingQueueIndicator } from '@/components/PendingQueueIndicator';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort, resumeSession } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionPendingMessages, useSessionUsage, useSetting } from '@/sync/storage';
import { canResumeSessionWithOptions } from '@/utils/agentCapabilities';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import type { ModelMode, PermissionMode } from '@/sync/permissionTypes';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

const CONFIGURABLE_MODEL_MODES = [
    'default',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
] as const;
type ConfigurableModelMode = (typeof CONFIGURABLE_MODEL_MODES)[number];

const isConfigurableModelMode = (mode: ModelMode): mode is ConfigurableModelMode => {
    return (CONFIGURABLE_MODEL_MODES as readonly string[]).includes(mode);
};

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
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
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
            tintColor: isConnected ? '#000' : '#8E8E93'
        };
    }, [session, isDataReady, sessionId, router]);

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
                    // Loading state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    // Deleted state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    // Normal session view
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} />
                )}
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
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    // Get permission mode from session object, default to 'default'
    const permissionMode = session.permissionMode || 'default';
    // Get model mode from session object - for Gemini sessions use explicit model, default to gemini-2.5-pro
    const isGeminiSession = session.metadata?.flavor === 'gemini';
    const modelMode = session.modelMode || (isGeminiSession ? 'gemini-2.5-pro' : 'default');
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const { messages: pendingMessages, isLoaded: pendingLoaded } = useSessionPendingMessages(sessionId);
    const experiments = useSetting('experiments');
    const expFileViewer = useSetting('expFileViewer');
    const expCodexResume = useSetting('expCodexResume');

    // Inactive session resume state
    const isSessionActive = session.presence === 'online';
    const allowCodexResume = experiments && expCodexResume;
    const isResumable = canResumeSessionWithOptions(session.metadata, { allowCodexResume });
    const [isResuming, setIsResuming] = React.useState(false);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    React.useEffect(() => {
        storage.getState().markSessionViewed(sessionId);
    }, [sessionId]);

    React.useEffect(() => {
        if (!pendingLoaded) {
            void sync.fetchPendingMessages(sessionId).catch(() => { });
        }
    }, [sessionId, pendingLoaded]);

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
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        storage.getState().updateSessionPermissionMode(sessionId, mode);
    }, [sessionId]);

    // Function to update model mode (for Gemini sessions)
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        // Only Gemini model modes are configurable from the UI today.
        if (isConfigurableModelMode(mode)) {
            storage.getState().updateSessionModelMode(sessionId, mode);
        }
    }, [sessionId]);

    // Handle resuming an inactive session
    const handleResumeSession = React.useCallback(async () => {
        if (!session.metadata?.machineId || !session.metadata?.path || !session.metadata?.flavor) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return;
        }

        if (session.metadata.flavor !== 'claude' && session.metadata.flavor !== 'codex' && session.metadata.flavor !== 'gemini') {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return;
        }
        if (session.metadata.flavor === 'codex' && !allowCodexResume) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return;
        }

        setIsResuming(true);
        try {
            const result = await resumeSession({
                sessionId,
                machineId: session.metadata.machineId,
                directory: session.metadata.path,
                agent: session.metadata.flavor,
                experimentalCodexResume: allowCodexResume,
            });

            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage);
            }
            // On success, the session will become active and UI will update automatically
        } catch (error) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
        } finally {
            setIsResuming(false);
        }
    }, [allowCodexResume, sessionId, session.metadata]);

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
            await stopRealtimeSession();
            tracking?.capture('voice_session_stopped');

            // Notify voice assistant about voice session stop
            voiceHooks.onVoiceStopped();
        }
    }, [realtimeStatus, sessionId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(() => ({
        onMicPress: handleMicrophonePress,
        isMicActive: realtimeStatus === 'connected' || realtimeStatus === 'connecting'
    }), [handleMicrophonePress, realtimeStatus]);

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);


        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId);
    }, [sessionId, realtimeStatus]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} />
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

    // Determine the status text to show for inactive sessions
    const inactiveStatusText = !isSessionActive
        ? (isResumable ? t('session.inactiveResumable') : t('session.inactiveNotResumable'))
        : null;

    const input = (
        <View>
            <PendingQueueIndicator
                sessionId={sessionId}
                count={(session.pendingCount ?? 0) || (pendingLoaded ? pendingMessages.length : 0)}
            />
            <AgentInput
                placeholder={t('session.inputPlaceholder')}
                value={message}
                onChangeText={setMessage}
                sessionId={sessionId}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                modelMode={modelMode}
                onModelModeChange={updateModelMode}
                metadata={session.metadata}
                profileId={session.metadata?.profileId ?? undefined}
                onProfileClick={session.metadata?.profileId !== undefined ? () => {
                    const profileId = session.metadata?.profileId;
                    const profileInfo = (profileId === null || (typeof profileId === 'string' && profileId.trim() === ''))
                        ? t('profiles.noProfile')
                        : (typeof profileId === 'string' ? profileId : t('status.unknown'));
                    Modal.alert(
                        t('profiles.title'),
                        `This session uses: ${profileInfo}\n\nProfiles are fixed per session. To use a different profile, start a new session.`,
                    );
                } : undefined}
                connectionStatus={{
                    text: isResuming ? t('session.resuming') : (inactiveStatusText || sessionStatus.statusText),
                    color: sessionStatus.statusColor,
                    dotColor: sessionStatus.statusDotColor,
                    isPulsing: isResuming || sessionStatus.isPulsing
                }}
                onSend={() => {
                    const text = message.trim();
                    if (!text) return;
                    setMessage('');
                    clearDraft();
                    trackMessageSent();

                    // If session is inactive but resumable, resume it and send the message through the agent.
                    if (!isSessionActive && isResumable) {
                        void (async () => {
                            try {
                                // Always enqueue as a server-side pending message first so:
                                // - the user message is preserved in history even if spawn fails
                                // - the agent can pull it when it is ready (via pending-pop)
                                await sync.enqueuePendingMessage(sessionId, text);
                                await handleResumeSession();
                            } catch (e) {
                                setMessage(text);
                                Modal.alert('Error', e instanceof Error ? e.message : 'Failed to resume session');
                            }
                        })();
                        return;
                    }

                    void (async () => {
                        try {
                            await sync.submitMessage(sessionId, text);
                        } catch (e) {
                            setMessage(text);
                            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to send message');
                        }
                    })();
                }}
                isSendDisabled={(!isSessionActive && !isResumable) || isResuming}
                onMicPress={micButtonState.onMicPress}
                isMicActive={micButtonState.isMicActive}
                onAbort={() => sessionAbort(sessionId)}
                showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
                onFileViewerPress={(experiments && expFileViewer) ? () => router.push(`/session/${sessionId}/files`) : undefined}
                // Autocomplete configuration
                autocompletePrefixes={['@', '/']}
                autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
                usageData={sessionUsage ? {
                    inputTokens: sessionUsage.inputTokens,
                    outputTokens: sessionUsage.outputTokens,
                    cacheCreation: sessionUsage.cacheCreation,
                    cacheRead: sessionUsage.cacheRead,
                    contextSize: sessionUsage.contextSize
                } : session.latestUsage ? {
                    inputTokens: session.latestUsage.inputTokens,
                    outputTokens: session.latestUsage.outputTokens,
                    cacheCreation: session.latestUsage.cacheCreation,
                    cacheRead: session.latestUsage.cacheRead,
                    contextSize: session.latestUsage.contextSize
                } : undefined}
                alwaysShowContextSize={alwaysShowContextSize}
            />
        </View>
    );


    return (
        <>
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
        </>
    )
}
