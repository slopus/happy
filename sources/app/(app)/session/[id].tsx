import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState, useMemo, useCallback } from "react";
import { View, FlatList, Text, ActivityIndicator, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { useRouter } from "expo-router";
import { getSessionName, getSessionState } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages, useSettings, useDaemonStatusByMachine } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAbort, sessionAllow, sessionDeny, spawnRemoteSession } from '@/sync/ops';
import { EmptyMessages } from '@/components/EmptyMessages';
import { Pressable } from 'react-native';
import { AgentInput } from '@/components/AgentInput';
import { RoundButton } from '@/components/RoundButton';
import { formatPermissionParams } from '@/utils/formatPermissionParams';
import { Deferred } from '@/components/Deferred';
import { Session } from '@/sync/storageTypes';
import { ElevenLabsProvider, useConversation } from '@elevenlabs/react-native';
import type { ConversationStatus, ConversationEvent, Role } from '@elevenlabs/react-native';
import { sessionToRealtimePrompt, messagesToPrompt } from '@/realtime/sessionToPrompt';
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
import { trackMessageSent, trackPermissionResponse } from '@/track';
import { tracking } from '@/track';
import { useAutocompleteSession } from '@/hooks/useAutocompleteSession';
import { AutoCompleteView } from '@/components/AutoCompleteView';
import { z } from 'zod';

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
        <ElevenLabsProvider>
            <SessionView sessionId={sessionId} session={session} />
        </ElevenLabsProvider>
    );
});

// Voice session state management
type VoiceSessionState = 
    | 'idle'           // Not connected, not attempting to connect
    | 'connecting'     // Starting connection to ElevenLabs
    | 'connected'      // Active voice session
    | 'disconnecting'; // Ending session

// This is configured in the ElevenLabs provider online
const defaultRealtimePrompt = `
You are a voice interface to Claude Code.

- You help the user understand what changes Claude Code made or where it got stuck.
- You proactively offer to send message to Claude Code.
- You submit on behalf of the user new messages to Claude Code
- Use messageClaudeCode tool to message Claude. This tool will take a long time often to return, so don't call the tool before the user has fully formulated their request.
- You help user approve or deny permission requests that Claude sends using processPermissionRequest. Do not approve / deny on your own accord - always wait for the user to explicitly approve / deny each request.

- You are not a powerful model. You must not attempt to make your own hard decisions, and by default assume the user is just narrating what they will eventually want to ask of claude code. Claude Code is an advanced coding agent that can actually make changes to files, do research, and more. You are a mere voice interface to Claude Code.

- You keep your statements short. You do not repeat what the user just told you. When the user complains about the code or is providing feedback, your job by default is to keep track of that almost silently. You let the user do the talking unless they ask you directly. You can simply say "ok" or "got it" after the user provides feedback
- You are especially short after you call tools. For example after sending a new message to Claude say "sent" or after approving permission say "approved".

Things to look out for
- Do your best to infer if the user is asking you directly, or if they are preparing to submit a message to Claude. Act accordingly

[Onboarding, do once during the conversation]
- When you feel like the user has completed their request - prompt the user with something like 'Let me know when you are ready to send this to Claude'

# Conversation history so far (if present)
{{initialConversationContext}}
`

function SessionView({ sessionId, session }: { sessionId: string, session: Session }) {
    const settings = useSettings();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const { messages: messagesRecentFirst, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    const [voiceState, setVoiceState] = useState<VoiceSessionState>('idle');
    const [isReviving, setIsReviving] = useState(false);
    const [permissionMode, setPermissionMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'>('default');
    const screenWidth = useWindowDimensions().width;
    const headerHeight = useHeaderHeight();
    const sessionStatus = getSessionState(session);
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

    // Define client tool function
    const messageClaudeCode = async (parameters: unknown) => {
        // Parse and validate the message parameter using Zod
        const messageSchema = z.object({
            message: z.string().min(1, 'Message cannot be empty')
        });
        const parsedMessage = messageSchema.safeParse(parameters);

        if (!parsedMessage.success) {
            console.error('❌ Invalid message parameter:', parsedMessage.error);
            return "error (invalid message parameter)";
        }

        const message = parsedMessage.data.message;
        console.log('🔍 askClaudeCode called with:', message);
        sync.sendMessage(sessionId, message);
        return "success";
    };

    const processPermissionRequest = async (parameters: unknown) => {
        const messageSchema = z.object({
            decision: z.enum(['allow', 'deny'])
        });
        const parsedMessage = messageSchema.safeParse(parameters);

        if (!parsedMessage.success) {
            console.error('❌ Invalid decision parameter:', parsedMessage.error);
            return "error (invalid decision parameter, expected 'allow' or 'deny')";
        }

        const decision = parsedMessage.data.decision;
        console.log('🔍 processPermissionRequest called with:', decision);
        
        // Check if there's an active permission request
        if (!permissionRequest) {
            console.error('❌ No active permission request');
            return "error (no active permission request)";
        }
        
        try {
            if (decision === 'allow') {
                await sessionAllow(sessionId, permissionRequest.id);
                trackPermissionResponse(true);
            } else {
                await sessionDeny(sessionId, permissionRequest.id);
                trackPermissionResponse(false);
            }
            return "success";
        } catch (error) {
            console.error('❌ Failed to process permission:', error);
            return `error (failed to ${decision} permission)`;
        }
    }

    // ElevenLabs conversation hook
    const conversation = useConversation({
        clientTools: {
            messageClaudeCode,
            processPermissionRequest
        },

        onConnect: ({ conversationId }: { conversationId: string }) => {
            console.log('✅ Connected to ElevenLabs conversation', conversationId);
            setVoiceState('connected');
            tracking?.capture('voice_session_started', { conversationId });
        },
        onDisconnect: () => {
            console.log('❌ Disconnected from ElevenLabs conversation');
            setVoiceState('idle');
            tracking?.capture('voice_session_stopped');
        },
        onError: (message: string) => {
            console.error('❌ ElevenLabs conversation error:', message);
            Modal.alert('Error', 'Failed to start voice session');
            setVoiceState('idle');
            tracking?.capture('voice_session_error', { error: message });
        },
        onMessage: ({ message, source }: { message: ConversationEvent; source: Role }) => {
            console.log(`💬 Message from ${source}:`, message);
        },
        onModeChange: ({ mode }: { mode: 'speaking' | 'listening' }) => {
            console.log(`🔊 Mode: ${mode}`);
        },
        onStatusChange: ({ status }: { status: ConversationStatus }) => {
            console.log(`📡 Status: ${status}`);
            // Map ElevenLabs status to our state
            if (status === 'disconnected') {
                setVoiceState('idle');
            } else if (status === 'connecting') {
                setVoiceState('connecting');
            } else if (status === 'connected') {
                setVoiceState('connected');
            }
        }
    });

    // On new messages from claude, push them to the realtime session
    const lengthOfMessagesAlreadyProcessed = React.useRef(0);

    // Handle microphone button press
    const handleMicrophonePress = useCallback(async () => {
        if (voiceState === 'connecting' || voiceState === 'disconnecting') {
            return; // Prevent actions during transitions
        }

        if (voiceState === 'idle') {
            setVoiceState('connecting');

            try {
                // Send initial context - all of the conversation so far
                const conversationContext = sessionToRealtimePrompt(session, messagesRecentFirst, {
                    maxCharacters: 100_000,
                    maxMessages: 20,
                    excludeToolCalls: false
                });
                console.log('🔍 setting initial context:', conversationContext);
                // Update the last processed message index to the current length of messages
                lengthOfMessagesAlreadyProcessed.current = messagesRecentFirst.length;

                await conversation.startSession({
                    agentId: 'agent_6701k211syvvegba4kt7m68nxjmw',
                    userId: sync.anonID, // Use the same anonymous user ID used for analytics
                    dynamicVariables: {
                        initialConversationContext: conversationContext
                    }
                });
                
                // This for some reason was not being picked up in time by the agent? Lets try the other way
                // conversation.sendContextualUpdate(conversationContext);
            } catch (error) {
                console.error('Failed to start ElevenLabs session:', error);
                Modal.alert('Error', 'Failed to start voice session');
                setVoiceState('idle');
                tracking?.capture('voice_session_error', { error: error instanceof Error ? error.message : 'Unknown error' });
            }
        } else if (voiceState === 'connected') {
            setVoiceState('disconnecting');
            await conversation.endSession();
            // State will be updated by onDisconnect callback
        }
    }, [voiceState, conversation, session, messagesRecentFirst]);

    // Cleanup on unmount
    React.useEffect(() => {
        return () => {
            if (conversation.status === 'connected') {
                conversation.endSession();
            }
        };
    }, []);

    
    React.useEffect(() => {
        if (conversation.status === 'connected' 
            && messagesRecentFirst.length > lengthOfMessagesAlreadyProcessed.current
        ) {
            console.log(`Messages so far: ${JSON.stringify(messagesRecentFirst, null, 2)}`);
            
            const newMessages = messagesRecentFirst.slice(0, messagesRecentFirst.length - lengthOfMessagesAlreadyProcessed.current);
            console.log(`pushing ${newMessages.length} new messages to ElevenLabs session`);
            
            // TODO: Control whether agent should respond based on message finality
            // If the message is final (Claude stopped thinking), we might want the agent to respond
            // Otherwise, this is a silent push of context - the agent won't respond unless the user asks something
            const update = messagesToPrompt(newMessages, {
                maxCharacters: 100_000,
                maxMessages: 20,
                excludeToolCalls: false
            })
            const updateWithContext = `[New messages arrived]:\n\n${update}`;
            console.log('🔍 sending update:', updateWithContext);
            conversation.sendContextualUpdate(updateWithContext);
            lengthOfMessagesAlreadyProcessed.current = messagesRecentFirst.length;
        }
    }, [messagesRecentFirst.length, conversation.status]);

    // When claude changes state from thinking -> idle, with a debounce of 300ms, lets prompt the user claude finished its work and summarize what it did and ask for any next steps (offer smart next steps based on the latest update)
    React.useEffect(() => {
        if (conversation.status !== 'connected') {
            return;
        }

        console.log('🔍 sessionStatus.state:', sessionStatus.state);

        if (sessionStatus.state === 'permission_required' && permissionRequest) {
            const permissionDetails = formatPermissionParams(permissionRequest.call);
            conversation.sendUserMessage(
                `Claude is requesting permission: ${permissionDetails}. Tell me briefly what the permission request is, and ask me if I want to allow or deny]`
            )
        }

        if (sessionStatus.state === 'waiting') {
            conversation.sendUserMessage(
                `What is the latest update from claude? Only tell me new information since the last user message`
            )
        }
    }, [conversation.status, sessionStatus.state]);

    const permissionRequest = React.useMemo(() => {
        let requests = session.agentState?.requests;
        if (!requests) {
            return null;
        }
        if (Object.keys(requests).length === 0) {
            return null;
        }
        return { id: Object.keys(requests)[0], call: requests[Object.keys(requests)[0]] };
    }, [session.agentState]);
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
                    {(sessionStatus.state !== 'disconnected' || !daemonStatus?.online) && (
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
                            isMicActive={voiceState === 'connected' || voiceState === 'connecting'}
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
                    )}
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