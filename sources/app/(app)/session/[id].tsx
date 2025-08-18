import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState, useMemo, useCallback } from "react";
import { View, FlatList, ActivityIndicator, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { useRouter } from "expo-router";
import { getSessionName, useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from "@/utils/sessionUtils";
import { useSession, useSessionMessages, useSessionUsage, useSettings, useSetting, useDaemonStatusByMachine, useRealtimeStatus, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAbort, sessionSwitch, machineSpawnNewSession } from '@/sync/ops';
import { EmptyMessages } from '@/components/EmptyMessages';
import { Pressable } from 'react-native';
import { AgentInput } from '@/components/AgentInput';
import { RoundButton } from '@/components/RoundButton';
import { Deferred } from '@/components/Deferred';
import { Session } from '@/sync/storageTypes';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { Ionicons } from '@expo/vector-icons';
import { useIsLandscape, useDeviceType, useHeaderHeight } from '@/utils/responsive';
import { StatusBar } from 'expo-status-bar';
import { AgentContentView } from '@/components/AgentContentView';
import { isRunningOnMac } from '@/utils/platform';
import { Modal } from '@/modal';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { trackMessageSent } from '@/track';
import { tracking } from '@/track';
import { useAutocompleteSession } from '@/hooks/useAutocompleteSession';
import { ChatFooter } from '@/components/ChatFooter';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { useDraft } from '@/hooks/useDraft';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useIsTablet } from '@/utils/responsive';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    const session = useSession(sessionId);
    if (!session) {
        return (
            <View style={{ flexGrow: 1, flexBasis: 0, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#666" />
            </View>
        )
    }
    return (
        <SessionView sessionId={sessionId} session={session} />
    );
});


function SessionView({ sessionId, session }: { sessionId: string, session: Session }) {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const isTablet = useIsTablet();
    const headerHeight = useHeaderHeight();
    const { messages: messagesRecentFirst, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    const realtimeStatus = useRealtimeStatus();
    const [isReviving, setIsReviving] = useState(false);
    // Get permission mode from session object, default to 'default'
    const permissionMode = session.permissionMode || 'default';
    // Get model mode from session object, default to 'default'
    const modelMode = session.modelMode || 'default';
    const screenWidth = useWindowDimensions().width;
    const sessionStatus = useSessionStatus(session);
    const lastSeenText = sessionStatus.statusText;
    const autocomplete = useAutocompleteSession(message, message.length);
    const daemonStatus = useDaemonStatusByMachine(session.metadata?.machineId || '');
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    // Function to update permission mode
    const updatePermissionMode = useCallback((mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => {
        storage.getState().updateSessionPermissionMode(sessionId, mode);
    }, [sessionId]);

    // Function to update model mode
    const updateModelMode = useCallback((mode: 'default' | 'adaptiveUsage' | 'sonnet' | 'opus') => {
        storage.getState().updateSessionModelMode(sessionId, mode);
    }, [sessionId]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: Platform.OS === 'web' ? headerHeight + safeArea.top : 0
        },
    }), [headerHeight, safeArea.top]);


    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = useCallback(async () => {
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
                Modal.alert('Error', 'Failed to start voice session');
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
    }, [sessionId]);

    const ListHeader = React.useMemo(() => {
        return <View style={{ flexDirection: 'row', alignItems: 'center', height: (Platform.OS === 'web' ? 0 : (headerHeight + safeArea.top)) + 32 }} />;
    }, [headerHeight, safeArea.top]);

    // Memoize FlatList props
    const keyExtractor = useCallback((item: any) => item.id, []);

    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView
            message={item}
            metadata={session.metadata}
            sessionId={sessionId}
        />
    ), [session.metadata, sessionId]);

    const contentContainerStyle = useMemo(() => ({
        paddingHorizontal: screenWidth > 700 ? 16 : 0
    }), [screenWidth]);

    const maintainVisibleContentPosition = useMemo(() => ({
        minIndexForVisible: 0,
        autoscrollToTopThreshold: 100,
    }), []);

    const ListFooter = useCallback(() => (
        <ChatFooter
            status={{
                state: sessionStatus.state,
                text: sessionStatus.state === 'disconnected' ? 'disconnected' :
                    sessionStatus.state === 'thinking' ? 'thinking...' :
                        sessionStatus.state === 'idle' ? 'idle' :
                            sessionStatus.state === 'permission_required' ? 'permission required' :
                                sessionStatus.state === 'waiting' ? 'connected' : '',
                color: sessionStatus.statusColor,
                dotColor: sessionStatus.statusDotColor,
                isPulsing: sessionStatus.isPulsing,
            }}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            onSwitch={() => sessionSwitch(sessionId, 'remote')}
        />
    ), [sessionStatus, permissionMode, sessionId]);

    const content = (
        <>
            <Deferred>
                {messagesRecentFirst.length > 0 && (
                    <FlatList
                        removeClippedSubviews={true}
                        data={messagesRecentFirst}
                        inverted={true}
                        keyExtractor={keyExtractor}
                        style={[headerDependentStyles.flatListStyle]}
                        maintainVisibleContentPosition={maintainVisibleContentPosition}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="none" // Interactive mode is still buggy
                        renderItem={renderItem}
                        contentContainerStyle={contentContainerStyle}
                        ListHeaderComponent={ListFooter}
                        ListFooterComponent={ListHeader}
                    />
                )}
            </Deferred>
            {sessionStatus.state === 'disconnected' && daemonStatus?.active && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 16 }}>
                    <RoundButton
                        title={isReviving ? "Reviving..." : "Revive session"}
                        onPress={async () => {
                            if (!isReviving && session.metadata?.machineId && session.metadata?.path) {
                                setIsReviving(true);
                                try {
                                    const result = await machineSpawnNewSession(session.metadata.machineId, session.metadata.path);
                                    if (result.sessionId && result.sessionId !== sessionId) {
                                        router.replace(`/session/${result.sessionId}`);
                                    }
                                } catch (error) {
                                    Modal.alert('Error', 'Failed to revive session');
                                } finally {
                                    setIsReviving(false);
                                }
                            }
                        }}
                        size="normal"
                        disabled={isReviving}
                        loading={isReviving}
                    />
                </View>
            )}
        </>
    );

    const placeholder = messagesRecentFirst.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="large" color="#C7C7CC" />
            )}
        </>
    ) : null;

    const input = (
        <AgentInput
            placeholder="Type a message ..."
            value={message}
            onChangeText={setMessage}
            sessionId={sessionId}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            modelMode={modelMode}
            onModelModeChange={updateModelMode}
            connectionStatus={{
                text: sessionStatus.statusText,
                color: sessionStatus.statusColor,
                dotColor: sessionStatus.statusDotColor,
                isPulsing: sessionStatus.isPulsing
            }}
            onSend={() => {
                if (message.trim()) {
                    setMessage('');
                    clearDraft();
                    sync.sendMessage(sessionId, message);
                    trackMessageSent();
                }
            }}
            onMicPress={micButtonState.onMicPress}
            isMicActive={micButtonState.isMicActive}
            onAbort={() => sessionAbort(sessionId)}
            showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
            onFileViewerPress={experiments ? () => router.push(`/session/${sessionId}/files`) : undefined}
            // Autocomplete configuration
            autocompletePrefixes={['@', '/']}
            autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
            usageData={sessionUsage ? {
                inputTokens: sessionUsage.inputTokens,
                outputTokens: sessionUsage.outputTokens,
                cacheCreation: sessionUsage.cacheCreation,
                cacheRead: sessionUsage.cacheRead,
                contextSize: sessionUsage.contextSize
            } : undefined}
            alwaysShowContextSize={alwaysShowContextSize}
        />
    );


    return (
        <>
            <StatusBar style="dark" translucent backgroundColor="transparent" />

            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: 'white',
                    zIndex: 1000,
                    shadowColor: '#000',
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: 0.1,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header - hidden in landscape mode on phone */}
            {!(isLandscape && deviceType === 'phone') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        title={getSessionName(session)}
                        subtitle={session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined}
                        onBackPress={() => router.back()}
                        onAvatarPress={() => router.push(`/session/${sessionId}/info`)}
                        avatarId={getSessionAvatarId(session)}
                        tintColor={sessionStatus.isConnected ? '#000' : '#8E8E93'}
                        isConnected={sessionStatus.isConnected}
                    />
                </View>
            )}

            {/* Voice Assistant Status Bar - positioned as overlay below header */}
            {!isTablet && !(isLandscape && deviceType === 'phone') && realtimeStatus !== 'disconnected' && (
                <View style={{
                    position: 'absolute',
                    top: safeArea.top + headerHeight, // Position below header
                    left: 0,
                    right: 0,
                    zIndex: 999 // Below header but above content
                }}>
                    <VoiceAssistantStatusBar variant="full" />
                </View>
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
                            backgroundColor: 'rgba(255, 255, 255, 0.9)',
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