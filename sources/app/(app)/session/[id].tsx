import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState, useMemo, useCallback } from "react";
import { View, FlatList, Text, ActivityIndicator, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { useRouter } from "expo-router";
import { getSessionName, useSessionStatus, getSessionAvatarId } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages, useSettings, useDaemonStatusByMachine, useRealtimeStatus, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAbort, sessionSwitch, spawnRemoteSession } from '@/sync/ops';
import { EmptyMessages } from '@/components/EmptyMessages';
import { Pressable, ScrollView, Keyboard } from 'react-native';
import { AgentInput } from '@/components/AgentInput';
import { RoundButton } from '@/components/RoundButton';
import { Deferred } from '@/components/Deferred';
import { Session } from '@/sync/storageTypes';
import { sessionToRealtimePrompt } from '@/realtime/sessionToPrompt';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsLandscape, useDeviceType, useHeaderHeight } from '@/utils/responsive';
import Animated from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import { AgentContentView } from '@/components/AgentContentView';
import { isRunningOnMac } from '@/utils/platform';
import { Modal } from '@/modal';
import { Header } from '@/components/navigation/Header';
import { trackMessageSent } from '@/track';
import { tracking } from '@/track';
import { useAutocompleteSession } from '@/hooks/useAutocompleteSession';
import { StatusDot } from '@/components/StatusDot';
import { ChatFooter } from '@/components/ChatFooter';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { useDraft } from '@/hooks/useDraft';


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
    const { messages: messagesRecentFirst, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    const realtimeStatus = useRealtimeStatus();
    const [isReviving, setIsReviving] = useState(false);
    // Get permission mode from session object, default to 'default'
    const permissionMode = session.permissionMode || 'default';
    const screenWidth = useWindowDimensions().width;
    const headerHeight = useHeaderHeight();
    const sessionStatus = useSessionStatus(session);
    const lastSeenText = sessionStatus.statusText;
    const autocomplete = useAutocompleteSession(message, message.length);
    const daemonStatus = useDaemonStatusByMachine(session.metadata?.machineId || '');
    
    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);
    
    // Function to update permission mode
    const updatePermissionMode = useCallback((mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => {
        storage.getState().updateSessionPermissionMode(sessionId, mode);
    }, [sessionId]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        emptyMessageContainer: {
            position: 'absolute' as const,
            bottom: 150,  // Fixed distance from bottom
            left: 0,
            right: 0,
            alignItems: 'center' as const,
        },
        emptyMessageWrapper: {
            flex: 1,
            position: 'relative' as const,
        },
        flatListStyle: {
            marginTop: Platform.OS === 'web' ? headerHeight + safeArea.top : 0
        },
    }), [headerHeight, safeArea.top]);


    // Handle microphone button press
    const handleMicrophonePress = useCallback(async () => {
        if (realtimeStatus === 'connecting') {
            return; // Prevent actions during transitions
        }

        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                // Send initial context - all of the conversation so far
                const conversationContext = sessionToRealtimePrompt(session, messagesRecentFirst, {
                    maxCharacters: 100_000,
                    maxMessages: 20,
                    excludeToolCalls: false
                });
                console.log('🔍 setting initial context:', conversationContext);

                await startRealtimeSession(sessionId, conversationContext);
                tracking?.capture('voice_session_started', { sessionId });
            } catch (error) {
                console.error('Failed to start realtime session:', error);
                Modal.alert('Error', 'Failed to start voice session');
                tracking?.capture('voice_session_error', { error: error instanceof Error ? error.message : 'Unknown error' });
            }
        } else if (realtimeStatus === 'connected') {
            await stopRealtimeSession();
            tracking?.capture('voice_session_stopped');
        }
    }, [realtimeStatus, session, messagesRecentFirst, sessionId]);

    // Trigger session visibility
    React.useEffect(() => {
        sync.onSessionVisible(sessionId);
    }, [sessionId]);

    const ListHeader = React.useMemo(() => {
        return <View style={{ flexDirection: 'row', alignItems: 'center', height: 32 }} />;
    }, []);

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
                    <Header
                        title={
                            <View style={{ alignItems: 'center' }}>
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={{
                                        fontSize: 16,
                                        fontWeight: '600',
                                        color: sessionStatus.isConnected ? '#000' : '#8E8E93',
                                        marginBottom: 2,
                                        ...Typography.default('semiBold')
                                    }}
                                >
                                    {getSessionName(session)}
                                </Text>
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <View style={{
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        height: 16,
                                        marginTop: 2,
                                        marginRight: 4
                                    }}>
                                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                                    </View>
                                    <Text style={{
                                        fontSize: 12,
                                        color: sessionStatus.statusColor,
                                        fontWeight: sessionStatus.shouldShowStatus ? '500' : '400',
                                        lineHeight: 16,
                                        ...Typography.default()
                                    }}>
                                        {sessionStatus.shouldShowStatus ? sessionStatus.statusText : lastSeenText}
                                    </Text>
                                </View>
                            </View>
                        }
                        headerLeft={() => (
                            <Pressable
                                onPress={() => router.back()}
                                hitSlop={15}
                            >
                                <Ionicons
                                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                    size={Platform.select({ ios: 28, default: 24 })}
                                    color="#000"
                                />
                            </Pressable>
                        )}
                        headerRight={() => (
                            <Pressable
                                onPress={() => router.push(`/session/${sessionId}/info`)}
                                hitSlop={15}
                                style={{
                                    width: 44,
                                    height: 44,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    marginRight: Platform.select({ ios: -8, default: -8 }),
                                }}
                            >
                                <Avatar id={getSessionAvatarId(session)} size={32} monochrome={!sessionStatus.isConnected} />
                            </Pressable>
                        )}
                        headerShadowVisible={false}
                    // headerStyle={{
                    //     borderBottomWidth: 0.5,
                    //     borderBottomColor: 'rgba(0, 0, 0, 0.1)',
                    // }}
                    />
                </View>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 32 : 0) }}>
                <AgentContentView>
                    <Deferred>
                        {messagesRecentFirst.length === 0 && isLoaded && (
                            <View style={headerDependentStyles.emptyMessageWrapper}>
                                <Pressable 
                                    style={headerDependentStyles.emptyMessageContainer}
                                    onPress={() => Keyboard.dismiss()}
                                >
                                    <EmptyMessages session={session} />
                                </Pressable>
                            </View>
                        )}
                        {messagesRecentFirst.length === 0 && !isLoaded && (
                            <View style={headerDependentStyles.emptyMessageWrapper}>
                                <Pressable 
                                    style={headerDependentStyles.emptyMessageContainer}
                                    onPress={() => Keyboard.dismiss()}
                                >
                                    <ActivityIndicator size="large" color="#C7C7CC" />
                                </Pressable>
                            </View>
                        )}
                        {messagesRecentFirst.length > 0 && (
                            <FlatList
                                removeClippedSubviews={true}
                                data={messagesRecentFirst}
                                inverted={true}
                                keyExtractor={keyExtractor}
                                style={[headerDependentStyles.emptyMessageWrapper, headerDependentStyles.flatListStyle]}
                                maintainVisibleContentPosition={maintainVisibleContentPosition}
                                keyboardShouldPersistTaps="handled"
                                keyboardDismissMode="none"
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
                                                const result = await spawnRemoteSession(session.metadata.machineId, session.metadata.path);
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
                    <AgentInput
                            placeholder="Type a message ..."
                            value={message}
                            onChangeText={setMessage}
                            permissionMode={permissionMode}
                            onPermissionModeChange={updatePermissionMode}
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
                                    sync.sendMessage(sessionId, message, permissionMode);
                                    trackMessageSent();
                                }
                            }}
                            onMicPress={handleMicrophonePress}
                            isMicActive={realtimeStatus === 'connected' || realtimeStatus === 'connecting'}
                            onAbort={() => sessionAbort(sessionId)}
                            showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
                            // Autocomplete configuration
                            autocompletePrefixes={['@', '/']}
                            autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
                    />
                </AgentContentView>
            </View>

            {/* Back button for landscape phone mode when header is hidden */}
            {isLandscape && deviceType === 'phone' && (
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
            )}
        </>
    )
}