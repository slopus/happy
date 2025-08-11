import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState, useMemo, useCallback } from "react";
import { View, FlatList, Text, ActivityIndicator, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { useRouter } from "expo-router";
import { getSessionName, useSessionStatus } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages, useSettings, useDaemonStatusByMachine, useRealtimeStatus } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAbort, sessionSwitch, spawnRemoteSession } from '@/sync/ops';
import { EmptyMessages } from '@/components/EmptyMessages';
import { Pressable } from 'react-native';
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
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import { AgentContentView } from '@/components/AgentContentView';
import { isRunningOnMac } from '@/utils/platform';
import { Modal } from '@/modal';
import { Header } from '@/components/navigation/Header';
import { trackMessageSent } from '@/track';
import { tracking } from '@/track';
import { useAutocompleteSession } from '@/hooks/useAutocompleteSession';
import { AutoCompleteView } from '@/components/AutoCompleteView';

// Animated status dot component
function StatusDot({ color, isPulsing, size = 6 }: { color: string; isPulsing?: boolean; size?: number }) {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        if (isPulsing) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1, // infinite
                true // reverse
            );
        } else {
            opacity.value = withTiming(1, { duration: 200 });
        }
    }, [isPulsing]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    return (
        <Animated.View
            style={[
                {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor: color,
                    marginRight: 4,
                },
                animatedStyle
            ]}
        />
    );
}

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
    const [permissionMode, setPermissionMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'>('default');
    const screenWidth = useWindowDimensions().width;
    const headerHeight = useHeaderHeight();
    const sessionStatus = useSessionStatus(session);
    const lastSeenText = sessionStatus.shouldShowStatus ? sessionStatus.statusText : 'active';
    const autocomplete = useAutocompleteSession(message, message.length);
    const daemonStatus = useDaemonStatusByMachine(session.metadata?.machineId || '');


    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        emptyMessageContainer: {
            flexGrow: 1,
            flexBasis: 0,
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
            marginTop: safeArea.top + headerHeight
        },
        flatListStyle: {
            marginTop: Platform.OS === 'web' ? headerHeight + safeArea.top : 0
        },
        listFooterHeight: {
            height: headerHeight + safeArea.top
        }
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

    const footer = React.useMemo(() => {
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

    const ListFooterComponent = useCallback(() => <View style={headerDependentStyles.listFooterHeight} />, [headerDependentStyles.listFooterHeight]);

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
                                        marginTop: 2
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
                                hitSlop={10}
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
                                hitSlop={10}
                                style={{
                                    width: 44,
                                    height: 44,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    marginRight: Platform.select({ ios: -8, default: -8 }),
                                }}
                            >
                                <Avatar id={sessionId} size={32} monochrome={!sessionStatus.isConnected} />
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
                    <Animated.View style={{ flexGrow: 1, flexBasis: 0 }}>
                        <Deferred>
                            {messagesRecentFirst.length === 0 && isLoaded && (
                                <View style={headerDependentStyles.emptyMessageContainer}>
                                    <EmptyMessages session={session} />
                                </View>
                            )}
                            {messagesRecentFirst.length === 0 && !isLoaded && (
                                <View style={headerDependentStyles.emptyMessageContainer}>
                                    <ActivityIndicator size="large" color="#C7C7CC" />
                                </View>
                            )}
                            {messagesRecentFirst.length > 0 && (
                                <FlatList
                                    removeClippedSubviews={true}
                                    data={messagesRecentFirst}
                                    inverted={true}
                                    keyExtractor={keyExtractor}
                                    style={headerDependentStyles.flatListStyle}
                                    maintainVisibleContentPosition={maintainVisibleContentPosition}
                                    keyboardShouldPersistTaps="handled"
                                    keyboardDismissMode="none"
                                    renderItem={renderItem}
                                    contentContainerStyle={contentContainerStyle}
                                    ListHeaderComponent={footer}
                                    ListFooterComponent={ListFooterComponent}
                                />
                            )}
                        </Deferred>
                        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 1000 }}>
                            <LinearGradient
                                colors={['rgba(255,255,255,0)', 'rgba(255,255,255,1)']}
                                locations={[0, 1]}
                                style={{ alignSelf: 'stretch', height: 8, pointerEvents: 'none' }}
                            />
                            <AutoCompleteView results={autocomplete} onSelect={() => { }} />
                        </View>

                    </Animated.View>

                    {sessionStatus.state === 'disconnected' && daemonStatus?.online && (
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
                        onSend={() => {
                            if (message.trim()) {
                                setMessage('');
                                sync.sendMessage(sessionId, message, permissionMode);
                                trackMessageSent();
                            }
                        }}
                        onMicPress={handleMicrophonePress}
                        isMicActive={realtimeStatus === 'connected' || realtimeStatus === 'connecting'}
                        onSwitch={() => sessionSwitch(sessionId, 'remote')}
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
                        onAbort={() => sessionAbort(sessionId)}
                        permissionMode={permissionMode}
                        onPermissionModeChange={setPermissionMode}
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
                    hitSlop={10}
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