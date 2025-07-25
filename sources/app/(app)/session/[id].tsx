import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState, useMemo, useCallback } from "react";
import { View, FlatList, Text, ActivityIndicator, Alert } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { Stack, useRouter } from "expo-router";
import { formatLastSeen, getSessionName, getSessionState, isSessionOnline } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import LottieView from 'lottie-react-native';
import { ConfigurationModal } from '@/components/ConfigurationModal';
import { Pressable } from 'react-native';
import { AgentInput } from '@/components/AgentInput';
import { RoundButton } from '@/components/RoundButton';
import { formatPermissionParams } from '@/utils/formatPermissionParams';
import { Deferred } from '@/components/Deferred';
import { Session } from '@/sync/storageTypes';
import { createRealtimeSession, zodToOpenAIFunction, type Tools, type Tool } from '@/realtime';
import { sessionToRealtimePrompt } from '@/realtime/sessionToPrompt';
import { z } from 'zod';
import { Ionicons } from '@expo/vector-icons';

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
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const realtimeSessionRef = React.useRef<Awaited<ReturnType<typeof createRealtimeSession>> | null>(null);

    const [showConfigModal, setShowConfigModal] = useState(false);
    const sessionStatus = getSessionState(session);
    const online = sessionStatus.isConnected;
    const lastSeenText = sessionStatus.isConnected ? 'Active now' : formatLastSeen(session.activeAt);
    
    // Define tools for the realtime session
    const tools: Tools = useMemo(() => ({
        sendClaudeCodeMessage: zodToOpenAIFunction(
            'sendClaudeCodeMessage',
            'Send a message to Claude Code to perform coding tasks',
            z.object({
                message: z.string().describe('The task or question to send to Claude Code')
            }),
            async ({ message }) => {
                // Send the message as if typed by the user
                sync.sendMessage(sessionId, message);
                
                // Return acknowledgment
                return { 
                    success: true, 
                    message: "I've sent your request to Claude Code. This may take some time to process. You can leave this chat as you won't receive a notification when it finishes. In the meantime, you can review other workstreams if you have any in progress."
                };
            }
        )
    }), [sessionId]);
    
    // Handle microphone button press
    const handleMicrophonePress = useCallback(async () => {
        if (!isRecording) {
            // Generate conversation context
            const conversationContext = sessionToRealtimePrompt(session, messages);
            
            // System prompt for the real-time assistant
            const systemPrompt = `You are a real-time coding assistant helping ${getSessionName(session)}. Your role is to:

1. Help the user understand what changes Claude Code made or where it got stuck
2. Be a proactive listener and help brainstorm new ideas or think through problems
3. When the user formulates a change they want to make, use the sendClaudeCodeMessage function to send tasks to Claude Code

Claude Code is a very smart coding model that can actually make changes to files. Once the user clearly articulates what they want, you will call the sendClaudeCodeMessage function to dispatch the task.

Remember: You are the voice interface to Claude Code, helping the user think through problems and formulate clear requests.

## Current Conversation Context

${conversationContext}`;
            
            try {
                const controls = await createRealtimeSession({
                    context: systemPrompt,
                    tools
                });
                
                // Set up update callback to trigger re-renders
                (controls as any)._setUpdateCallback(() => forceUpdate());
                
                realtimeSessionRef.current = controls;
                setIsRecording(true);
            } catch (error) {
                console.error('Failed to create realtime session:', error);
                Alert.alert('Error', 'Failed to start voice session');
            }
        } else {
            // End the current session
            if (realtimeSessionRef.current) {
                realtimeSessionRef.current.end();
                realtimeSessionRef.current = null;
            }
            setIsRecording(false);
        }
    }, [isRecording, tools, session, messages]);
    
    // Cleanup on unmount
    React.useEffect(() => {
        return () => {
            if (realtimeSessionRef.current) {
                realtimeSessionRef.current.end();
                realtimeSessionRef.current = null;
            }
        };
    }, []);
    
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

    const status = React.useMemo(() => {
        if (sessionStatus.shouldShowStatus) {
            return (
                <Text style={{ color: '#999', fontSize: 14, marginLeft: 8 }}>
                    {sessionStatus.state === 'disconnected' ? 'Session disconnected' : 'Thinking...'}
                </Text>
            );
        }
        return null;
    }, [sessionStatus]);

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
                            <Text style={{ fontSize: 18, fontWeight: '600', lineHeight: 18 }}>{getSessionName(session)}</Text>
                            <Text style={{ color: (online ? '#34C759' : '#999'), marginTop: 0, fontSize: 12 }}>{(online ? 'online' : lastSeenText)}</Text>
                        </View>
                    ),
                    headerRight(props) {
                        return (
                            <Pressable
                                onPress={() => router.push(`/session/${sessionId}/info`)}
                                hitSlop={10}
                                style={{ flexDirection: 'row', alignItems: 'center', marginRight: -4 }}
                            >
                                <Avatar id={sessionId} size={32} monochrome={!online} />
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
                </View>
                <AgentInput
                    placeholder="Type a message ..."
                    value={message}
                    onChangeText={setMessage}
                    onSend={message.trim() ? () => {
                        setMessage('');
                        sync.sendMessage(sessionId, message);
                    } : handleMicrophonePress}
                    sendIcon={message.trim() ? undefined : (
                        <Ionicons 
                            name={isRecording ? "stop-circle" : "mic"} 
                            size={24} 
                            color={isRecording ? "#FF3B30" : "#007AFF"} 
                        />
                    )}
                    status={
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 4 }}>
                            {sessionStatus.state === 'thinking' && 
                                <RoundButton 
                                    size='normal' 
                                    display='inverted' 
                                    title={"Abort"} 
                                    action={() => sync.abort(sessionId)} 
                                />
                            }
                            {status}
                        </View>
                    }
                />
            </KeyboardAvoidingView>
            <ConfigurationModal
                visible={showConfigModal}
                onClose={() => setShowConfigModal(false)}
            />
        </>
    )
}