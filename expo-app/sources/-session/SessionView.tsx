import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/sessions/agentInput';
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
import { storage, useIsDataReady, useLocalSetting, useMachine, useRealtimeStatus, useSessionMessages, useSessionPendingMessages, useSessionUsage, useSetting, useSettings } from '@/sync/storage';
import { canResumeSessionWithOptions, getAgentVendorResumeId } from '@/agents/resumeCapabilities';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor, buildResumeSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getResumePreflightIssues, getResumePreflightPrefetchPlan } from '@/agents/catalog';
import { useResumeCapabilityOptions } from '@/agents/useResumeCapabilityOptions';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities, useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { describeAcpLoadSessionSupport } from '@/agents/acpRuntimeResume';
import type { ModelMode, PermissionMode } from '@/sync/permissionTypes';
import { computePendingActivityAt } from '@/sync/unread';
import { getPendingQueueWakeResumeOptions } from '@/sync/pendingQueueWake';
import { getPermissionModeOverrideForSpawn } from '@/sync/permissionModeOverride';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/resumeSessionBase';
import { chooseSubmitMode } from '@/sync/submitMode';
import { isMachineOnline } from '@/utils/machineUtils';
import { getInactiveSessionUiState } from './sessionResumeUi';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
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

function formatResumeSupportDetailCode(code: 'cliNotDetected' | 'capabilityProbeFailed' | 'acpProbeFailed' | 'loadSessionFalse'): string {
    switch (code) {
        case 'cliNotDetected':
            return t('session.resumeSupportDetails.cliNotDetected');
        case 'capabilityProbeFailed':
            return t('session.resumeSupportDetails.capabilityProbeFailed');
        case 'acpProbeFailed':
            return t('session.resumeSupportDetails.acpProbeFailed');
        case 'loadSessionFalse':
            return t('session.resumeSupportDetails.loadSessionFalse');
    }
}

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
    // Get model mode from session object - default is agent-specific (Gemini needs an explicit default)
    const agentId = resolveAgentIdFromFlavor(session.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    const modelMode = session.modelMode || getAgentCore(agentId).model.defaultMode;
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const { messages: pendingMessages } = useSessionPendingMessages(sessionId);
    const expFileViewer = useSetting('expFileViewer');
    const settings = useSettings();

    // Inactive session resume state
    const isSessionActive = session.presence === 'online';
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: typeof machineId === 'string' ? machineId : null,
        settings,
        enabled: !isSessionActive,
    });

    const { state: machineCapabilitiesState } = useMachineCapabilitiesCache({
        machineId: typeof machineId === 'string' ? machineId : null,
        enabled: false,
        request: { requests: [] },
    });
    const machineCapabilitiesResults = React.useMemo(() => {
        if (machineCapabilitiesState.status !== 'loaded' && machineCapabilitiesState.status !== 'loading') return undefined;
        return machineCapabilitiesState.snapshot?.response.results as any;
    }, [machineCapabilitiesState]);

    const vendorResumeId = React.useMemo(() => {
        const field = getAgentCore(agentId).resume.vendorResumeIdField;
        if (!field) return '';
        const raw = (session.metadata as any)?.[field];
        return typeof raw === 'string' ? raw.trim() : '';
    }, [agentId, session.metadata]);

    const acpLoadSessionSupport = React.useMemo(() => {
        if (!vendorResumeId) return null;
        if (getAgentCore(agentId).resume.runtimeGate !== 'acpLoadSession') return null;
        return describeAcpLoadSessionSupport(agentId, machineCapabilitiesResults);
    }, [agentId, machineCapabilitiesResults, vendorResumeId]);

    const isResumable = canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions);
    const [isResuming, setIsResuming] = React.useState(false);

    const machine = useMachine(typeof machineId === 'string' ? machineId : '');
    const isMachineReachable = Boolean(machine) && isMachineOnline(machine!);

    const inactiveUi = React.useMemo(() => {
        return getInactiveSessionUiState({
            isSessionActive,
            isResumable,
            isMachineOnline: isMachineReachable,
        });
    }, [isMachineReachable, isResumable, isSessionActive]);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    const pendingActivityAt = computePendingActivityAt(session.metadata);
    const isFocusedRef = React.useRef(false);
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMarkedRef = React.useRef<{ sessionSeq: number; pendingActivityAt: number } | null>(null);

    const markSessionViewed = React.useCallback(() => {
        void sync.markSessionViewed(sessionId).catch(() => { });
    }, [sessionId]);

    useFocusEffect(React.useCallback(() => {
        isFocusedRef.current = true;
        {
            const current = storage.getState().sessions[sessionId];
            lastMarkedRef.current = {
                sessionSeq: current?.seq ?? 0,
                pendingActivityAt: computePendingActivityAt(current?.metadata),
            };
        }
        markSessionViewed();
        return () => {
            isFocusedRef.current = false;
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
            markSessionViewed();
        };
    }, [markSessionViewed, sessionId]));

    React.useEffect(() => {
        if (!isFocusedRef.current) return;

        const sessionSeq = session.seq ?? 0;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq && last.pendingActivityAt >= pendingActivityAt) return;

        lastMarkedRef.current = { sessionSeq, pendingActivityAt };
        if (markViewedTimeoutRef.current) clearTimeout(markViewedTimeoutRef.current);
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            markSessionViewed();
        }, 250);
        return () => {
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
        };
    }, [markSessionViewed, pendingActivityAt, session.seq]);

    React.useEffect(() => {
        void sync.fetchPendingMessages(sessionId).catch(() => { });
    }, [sessionId, session.metadataVersion]);

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

    // Function to update model mode (only for agents that expose model selection in the UI)
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        const core = getAgentCore(agentId);
        if (core.model.supportsSelection !== true) return;
        if (!core.model.allowedModes.includes(mode)) return;
        storage.getState().updateSessionModelMode(sessionId, mode);
    }, [agentId, sessionId]);

    // Handle resuming an inactive session
    const handleResumeSession = React.useCallback(async () => {
        if (!session.metadata?.machineId || !session.metadata?.path || !session.metadata?.flavor) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return;
        }
        if (!canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)) {
            if (acpLoadSessionSupport?.kind === 'error' || acpLoadSessionSupport?.kind === 'unknown') {
                const detailLines: string[] = [];
                if (acpLoadSessionSupport?.code) {
                    detailLines.push(formatResumeSupportDetailCode(acpLoadSessionSupport.code));
                }
                if (acpLoadSessionSupport?.rawMessage) {
                    detailLines.push(acpLoadSessionSupport.rawMessage);
                }
                const detail = detailLines.length > 0 ? `\n\n${t('common.details')}: ${detailLines.join('\n')}` : '';
                Modal.alert(t('common.error'), `${t('session.resumeFailed')}${detail}`);
            } else {
                Modal.alert(t('common.error'), t('session.resumeFailed'));
            }
            return;
        }
        if (!isMachineReachable) {
            Modal.alert(t('common.error'), t('session.machineOfflineCannotResume'));
            return;
        }

        const sessionEncryptionKeyBase64 = sync.getSessionEncryptionKeyBase64ForResume(sessionId);
        if (!sessionEncryptionKeyBase64) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return;
        }

        setIsResuming(true);
        try {
            const permissionOverride = getPermissionModeOverrideForSpawn(session);
            const base = buildResumeSessionBaseOptionsFromSession({
                sessionId,
                session,
                resumeCapabilityOptions,
                permissionOverride,
            });
            if (!base) {
                Modal.alert(t('common.error'), t('session.resumeFailed'));
                return;
            }

            const snapshotBefore = getMachineCapabilitiesSnapshot(base.machineId);
            const resultsBefore = snapshotBefore?.response.results as any;
            const preflightPlan = getResumePreflightPrefetchPlan({ agentId, settings, results: resultsBefore });
            if (preflightPlan) {
                try {
                    await prefetchMachineCapabilities({
                        machineId: base.machineId,
                        request: preflightPlan.request,
                        timeoutMs: preflightPlan.timeoutMs,
                    });
                } catch {
                    // Non-blocking; fall back to attempting resume (pending queue preserves user message).
                }
            }

            const snapshot = getMachineCapabilitiesSnapshot(base.machineId);
            const results = snapshot?.response.results as any;
            const issues = getResumePreflightIssues({
                agentId,
                experiments: getAgentResumeExperimentsFromSettings(agentId, settings),
                results,
            });

            const blockingIssue = issues[0] ?? null;
            if (blockingIssue) {
                const openMachine = await Modal.confirm(
                    t(blockingIssue.titleKey),
                    t(blockingIssue.messageKey),
                    { confirmText: t(blockingIssue.confirmTextKey) }
                );
                if (openMachine && blockingIssue.action === 'openMachine') {
                    router.push(`/machine/${base.machineId}` as any);
                }
                return;
            }

            const result = await resumeSession({
                ...base,
                sessionEncryptionKeyBase64,
                sessionEncryptionVariant: 'dataKey',
                ...buildResumeSessionExtrasFromUiState({
                    agentId,
                    settings,
                }),
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
    }, [agentId, resumeCapabilityOptions, router, session, sessionId, settings]);

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

    const showInactiveNotResumableNotice = inactiveUi.noticeKind === 'not-resumable';
    const showMachineOfflineNotice = inactiveUi.noticeKind === 'machine-offline';
    const providerName = getAgentCore(agentId).connectedService?.name ?? t('status.unknown');
    const machineName = machine?.metadata?.displayName ?? machine?.metadata?.host ?? t('status.unknown');

    const bottomNotice = React.useMemo(() => {
        if (showInactiveNotResumableNotice) {
            const extra = (() => {
                if (!acpLoadSessionSupport) return '';
                if (acpLoadSessionSupport.kind === 'supported') return '';
                const note = acpLoadSessionSupport.kind === 'unknown'
                    ? `\n\n${t('session.resumeSupportNoteChecking')}`
                    : `\n\n${t('session.resumeSupportNoteUnverified')}`;

                const detailLines: string[] = [];
                if (acpLoadSessionSupport.code) {
                    detailLines.push(formatResumeSupportDetailCode(acpLoadSessionSupport.code));
                }
                if (acpLoadSessionSupport.rawMessage) {
                    detailLines.push(acpLoadSessionSupport.rawMessage);
                }
                const detail = detailLines.length > 0 ? `\n\n${t('common.details')}: ${detailLines.join('\n')}` : '';
                return `${note}${detail}`;
            })();
            return {
                title: t('session.inactiveNotResumableNoticeTitle'),
                body: `${t('session.inactiveNotResumableNoticeBody', { provider: providerName })}${extra}`,
            };
        }
        if (showMachineOfflineNotice) {
            return {
                title: t('session.machineOfflineNoticeTitle'),
                body: t('session.machineOfflineNoticeBody', { machine: machineName }),
            };
        }
        return null;
    }, [acpLoadSessionSupport, machineName, providerName, showInactiveNotResumableNotice, showMachineOfflineNotice]);

    let content = (
        <>
            <Deferred>
                {(messages.length > 0 || pendingMessages.length > 0) && (
                    <ChatList
                        session={session}
                        bottomNotice={bottomNotice}
                    />
                )}
            </Deferred>
        </>
    );
    const placeholder = (messages.length === 0 && pendingMessages.length === 0) ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    // Determine the status text to show for inactive sessions
    const inactiveStatusText = inactiveUi.inactiveStatusTextKey ? t(inactiveUi.inactiveStatusTextKey) : null;

    const shouldShowInput = inactiveUi.shouldShowInput;
    const hasWriteAccess = !session.accessLevel || session.accessLevel === 'edit' || session.accessLevel === 'admin';
    const isReadOnly = session.accessLevel === 'view';

    const input = shouldShowInput ? (
        <View>
            <AgentInput
                placeholder={isReadOnly ? t('session.sharing.viewOnlyMode') : t('session.inputPlaceholder')}
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
                            `${t('profiles.sessionUses', { profile: profileInfo })}\n\n${t('profiles.profilesFixedPerSession')}`,
                        );
                    } : undefined}
                connectionStatus={{
                    text: isResuming ? t('session.resuming') : (inactiveStatusText || sessionStatus.statusText),
                    color: sessionStatus.statusColor,
                    dotColor: sessionStatus.statusDotColor,
                    isPulsing: isResuming || sessionStatus.isPulsing
                }}
                onSend={() => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }
                    const text = message.trim();
                    if (!text) return;
                    setMessage('');
                    clearDraft();
                    trackMessageSent();

                    const configuredMode = storage.getState().settings.sessionMessageSendMode;
                    const submitMode = chooseSubmitMode({ configuredMode, session });

                    if (submitMode === 'server_pending') {
                        void (async () => {
                            try {
                                await sync.enqueuePendingMessage(sessionId, text);
                            } catch (e) {
                                setMessage(text);
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                                return;
                            }

                            const wakeOpts = getPendingQueueWakeResumeOptions({
                                sessionId,
                                session,
                                resumeCapabilityOptions,
                                permissionOverride: getPermissionModeOverrideForSpawn(session),
                            });
                            if (!wakeOpts) return;

                            try {
                                const sessionEncryptionKeyBase64 = sync.getSessionEncryptionKeyBase64ForResume(sessionId);
                                if (!sessionEncryptionKeyBase64) {
                                    Modal.alert(t('common.error'), t('session.resumeFailed'));
                                    return;
                                }

                                const result = await resumeSession({
                                    ...wakeOpts,
                                    sessionEncryptionKeyBase64,
                                    sessionEncryptionVariant: 'dataKey',
                                });
                                if (result.type === 'error') {
                                    Modal.alert(t('common.error'), result.errorMessage);
                                }
                            } catch {
                                Modal.alert(t('common.error'), t('session.resumeFailed'));
                            }
                        })();
                        return;
                    }

                    // If session is inactive but resumable, resume it and send the message through the agent.
                    if (!isSessionActive && isResumable) {
                        void (async () => {
                            try {
                                // Always enqueue as a server-side pending message first so:
                                // - the user message is preserved even if spawn fails
                                // - the agent can pull it when it is ready (metadata-backed messageQueueV1)
                                await sync.enqueuePendingMessage(sessionId, text);
                                await handleResumeSession();
                            } catch (e) {
                                setMessage(text);
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToResumeSession'));
                            }
                        })();
                        return;
                    }

                    void (async () => {
                        try {
                            await sync.submitMessage(sessionId, text);
                        } catch (e) {
                            setMessage(text);
                            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                        }
                    })();
                }}
                isSendDisabled={!shouldShowInput || isResuming || isReadOnly}
                onMicPress={micButtonState.onMicPress}
                isMicActive={micButtonState.isMicActive}
                onAbort={() => sessionAbort(sessionId)}
                showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
                onFileViewerPress={(settings.experiments === true && expFileViewer === true) ? () => router.push(`/session/${sessionId}/files`) : undefined}
                // Autocomplete configuration
                autocompletePrefixes={['@', '/']}
                autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
                disabled={isReadOnly}
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
    ) : null;


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
