import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState } from "react";
import { View, FlatList, Text, ActivityIndicator } from "react-native";
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


import {
    mediaDevices,
    RTCPeerConnection,
    MediaStream,
    RTCView,
  } from 'react-native-webrtc'

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

    const [showConfigModal, setShowConfigModal] = useState(false);
    const sessionStatus = getSessionState(session);
    const online = sessionStatus.isConnected;
    const lastSeenText = sessionStatus.isConnected ? 'Active now' : formatLastSeen(session.activeAt);
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
                    placeholder="Type a message (app)..."
                    value={message}
                    onChangeText={setMessage}
                    onSend={() => {
                        setMessage('');
                        sync.sendMessage(sessionId, message);
                    }}
                    status={
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 4 }}>
                            <RoundButton size='normal' display='inverted' title={"Abort"} action={() => sync.abort(sessionId)} />
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