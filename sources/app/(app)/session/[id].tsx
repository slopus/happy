import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, FlatList, Text, ActivityIndicator, Alert, Animated } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { Stack, useRouter } from "expo-router";
import { formatLastSeen, getSessionName, getSessionState, isSessionOnline } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages, useSettings } from '@/sync/storage';
import { sync } from '@/sync/sync';
import LottieView from 'lottie-react-native';
import { Pressable } from 'react-native';
import { AgentInput } from '@/components/AgentInput';
import { RoundButton } from '@/components/RoundButton';
import { formatPermissionParams } from '@/utils/formatPermissionParams';
import { Deferred } from '@/components/Deferred';
import { Session } from '@/sync/storageTypes';
import { createRealtimeSession, zodToOpenAIFunction, type Tools, type Tool } from '@/realtime';
import { sessionToRealtimePrompt, messagesToPrompt } from '@/realtime/sessionToPrompt';
import { z } from 'zod';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { LinearGradient } from 'expo-linear-gradient';

// Animated status dot component
function StatusDot({ color, isPulsing, size = 6 }: { color: string; isPulsing?: boolean; size?: number }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 0.3,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulseAnim,
                marginRight: 4,
            }}
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

    return <SessionView sessionId={sessionId} session={session} />;
});

function SessionView({ sessionId, session }: { sessionId: string, session: Session }) {
    const settings = useSettings();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const realtimeSessionRef = React.useRef<Awaited<ReturnType<typeof createRealtimeSession>> | null>(null);
    const isCreatingSessionRef = React.useRef(false);

    const sessionStatus = getSessionState(session);
    const online = sessionStatus.isConnected;
    const lastSeenText = sessionStatus.shouldShowStatus ? sessionStatus.statusText : 'active';

    // Define tools for the realtime session
    const tools: Tools = useMemo(() => ({
        askClaudeCode: zodToOpenAIFunction(
            'askClaudeCode',
            'This is your main tool to get any work done. You can use it to submit tasks to Claude Code.',
            z.object({
                message: z.string().describe('The task or question to send to Claude Code')
            }),
            async ({ message }) => {
                // Send the message as if typed by the user
                sync.sendMessage(sessionId, message);

                // Return acknowledgment
                return {
                    success: true,
                    message: "I've sent your request to Claude Code. This may take some time to process. You can leave this chat as will receive a notification when claude code is done. In the meantime, you can review other sessions"
                };
            }
        )
    }), [sessionId]);

    // Handle microphone button press
    const handleMicrophonePress = useCallback(async () => {
        // Prevent multiple simultaneous session creations
        if (isCreatingSessionRef.current) {
            return;
        }

        if (!isRecording && !realtimeSessionRef.current) {
            // Mark that we're creating a session
            isCreatingSessionRef.current = true;
            setIsRecording(true); // Set this immediately to update UI

            // Generate conversation context
            const conversationContext = sessionToRealtimePrompt(session, messages, {
                maxCharacters: 100_000,
                maxMessages: 20,
                excludeToolCalls: false
            });

            // System prompt for the real-time assistant
            const systemPrompt = `You are a voice interface to Claude Code. Your role is to:

1. Help the user understand what changes Claude Code made or where it got stuck
2. Help the user 
3. When the user formulates a change they want to make, use the askClaudeCode function to send tasks to Claude Code

Claude Code is an advanced coding agent that can actually make changes to files, do research, and more.

Remember: You are the voice interface to Claude Code, helping the user think through problems and formulate clear requests.

## Current Conversation Context

${conversationContext}`;

            try {
                const controls = await createRealtimeSession({
                    context: systemPrompt,
                    tools,
                    settings
                });

                // Set up update callback to trigger re-renders
                (controls as any)._setUpdateCallback(() => forceUpdate());

                realtimeSessionRef.current = controls;
            } catch (error) {
                console.error('Failed to create realtime session:', error);
                Alert.alert('Error', 'Failed to start voice session');
                setIsRecording(false); // Reset on error
                realtimeSessionRef.current = null;
            } finally {
                isCreatingSessionRef.current = false;
            }
        } else if (isRecording && realtimeSessionRef.current) {
            // End the current session
            realtimeSessionRef.current.end();
            realtimeSessionRef.current = null;
            setIsRecording(false);
        }
    }, [isRecording, tools, session, messages, settings]);

    // Cleanup on unmount
    React.useEffect(() => {
        return () => {
            if (realtimeSessionRef.current) {
                realtimeSessionRef.current.end();
                realtimeSessionRef.current = null;
            }
        };
    }, []);

    // On new messages from claude, push them to the realtime session
    React.useEffect(() => {
        if (realtimeSessionRef.current) {
            console.log('pushing content to realtime session, poorly assuming a single new message arrived');
            realtimeSessionRef.current.pushContent(
                // Assuming its reversed
                messagesToPrompt(messages.slice(0, 1), {
                    maxCharacters: 100_000,
                    maxMessages: 20,
                    excludeToolCalls: false
                })
            );
        }
    }, [messages.length]);

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
        if (!permissionRequest) {
            return <View style={{ flexDirection: 'row', alignItems: 'center', height: 32 }} />;
        }
        return (
            <View style={{ flexDirection: 'row', justifyContent: 'center', paddingBottom: 24, paddingTop: 16, paddingHorizontal: 16 }}>
                <View style={{
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 12,
                    flexGrow: 1,
                    flexBasis: 0,
                    maxWidth: 700,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    backgroundColor: 'white',
                    paddingVertical: 12,
                    boxShadow: '0px 0px 8px 0px rgba(0,0,0,0.2)',
                }}>
                    <Text style={{ fontSize: 18, color: '#666', fontWeight: '600' }}>
                        Permission request
                    </Text>
                    <Text style={{ fontSize: 24, color: '#666' }}>
                        {permissionRequest?.call.tool}
                    </Text>
                    <Text style={{ fontSize: 24, color: '#666' }}>
                        {formatPermissionParams(permissionRequest?.call.arguments, 2, 20)}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
                        <RoundButton size='normal' title={"Deny"} onPress={() => sync.deny(sessionId, permissionRequest?.id ?? '')} />
                        <RoundButton size='normal' title={"Allow"} onPress={() => sync.allow(sessionId, permissionRequest?.id ?? '')} />
                    </View>
                </View>
            </View>
        )
    }, [permissionRequest]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: () => (
                        <View style={{ flexDirection: 'column', alignItems: 'center', alignContent: 'center' }}>
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={{
                                    fontSize: 14,
                                    fontWeight: '600',
                                    color: sessionStatus.isConnected ? '#000' : '#8E8E93',
                                    marginBottom: 2,
                                    maxWidth: 200,
                                    ...Typography.default('semiBold')
                                }}
                            >
                                {getSessionName(session)}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                                <Text style={{
                                    fontSize: 12,
                                    color: sessionStatus.statusColor,
                                    fontWeight: sessionStatus.shouldShowStatus ? '500' : '400',
                                    ...Typography.default()
                                }}>
                                    {sessionStatus.shouldShowStatus ? sessionStatus.statusText : lastSeenText}
                                </Text>
                            </View>
                        </View>
                    ),
                    headerRight(props) {
                        return (
                            <Pressable
                                onPress={() => router.push(`/session/${sessionId}/info`)}
                                hitSlop={10}
                                style={{ flexDirection: 'row', alignItems: 'center', marginRight: -4 }}
                            >
                                <Avatar id={sessionId} size={32} monochrome={!sessionStatus.isConnected} />
                            </Pressable>
                        )
                    },
                }}
            />
            <KeyboardAvoidingView
                behavior="translate-with-padding"
                keyboardVerticalOffset={safeArea.top + 44}
                style={{ flexGrow: 1, flexBasis: 0, marginBottom: safeArea.bottom }}
            >
                <View style={{ flexGrow: 1, flexBasis: 0 }}>
                    <Deferred>
                        {messages.length === 0 && isLoaded && (
                            <View style={{ flexGrow: 1, flexBasis: 0, justifyContent: 'center', alignItems: 'center' }}>
                                <LottieView source={require('@/assets/animations/popcorn.json')} autoPlay={true} loop={false} style={{ width: 180, height: 180 }} />
                                <Text style={{ color: '#666', fontSize: 20, marginTop: 16 }}>No messages yet</Text>
                            </View>
                        )}
                        {messages.length === 0 && !isLoaded && (
                            <View style={{ flexGrow: 1, flexBasis: 0, justifyContent: 'center', alignItems: 'center' }}>

                            </View>
                        )}
                        {messages.length > 0 && (
                            <FlatList
                                data={messages}
                                inverted={true}
                                keyExtractor={(item) => item.id}
                                maintainVisibleContentPosition={{
                                    minIndexForVisible: 0,
                                    autoscrollToTopThreshold: 100,
                                }}
                                renderItem={({ item }) => (
                                    <MessageView
                                        message={item}
                                        metadata={session.metadata}
                                        sessionId={sessionId}
                                    />
                                )}
                                ListHeaderComponent={footer}
                                ListFooterComponent={() => <View style={{ height: 8 }} />}
                            />
                        )}
                    </Deferred>
                    {/* Gradient transition */}
                    <LinearGradient
                        colors={['rgba(255,255,255,0)', 'rgba(255,255,255,1)']}
                        locations={[0, 1]}
                        style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: 8,
                            pointerEvents: 'none',
                        }}
                    />
                </View>


                <AgentInput
                    placeholder="Type a message ..."
                    value={message}
                    onChangeText={setMessage}
                    onSend={message.trim() ? () => {
                        setMessage('');
                        sync.sendMessage(sessionId, message);
                    } : handleMicrophonePress}
                    sendIcon={message.trim() ? undefined : settings.inferenceOpenAIKey ? (
                        <Ionicons
                            name={isRecording ? "stop" : "headset"}
                            size={isRecording ? 20 : 22}
                            color="#fff"
                        />
                    ) : undefined}
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
                    onAbort={() => sync.abort(sessionId)}
                />
            </KeyboardAvoidingView>
        </>
    )
}