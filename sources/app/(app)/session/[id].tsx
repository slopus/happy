import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState } from "react";
import { View, FlatList } from "react-native";
import { Text } from '@/components/StyledText';
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { Stack } from "expo-router";
import { formatLastSeen, getSessionName, isSessionOnline } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import LottieView from 'lottie-react-native';
import { ConfigurationModal } from '@/components/ConfigurationModal';
import { Pressable } from 'react-native';
import { AgentInput } from '@/components/AgentInput';
import { RoundButton } from '@/components/RoundButton';

export default function Session() {
    const safeArea = useSafeAreaInsets();
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    const session = useSession(sessionId)!;
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');

    const [showConfigModal, setShowConfigModal] = useState(false);
    const online = isSessionOnline(session);
    const lastSeenText = formatLastSeen(session.presence);
    const thinking = session.thinking && session.thinkingAt > Date.now() - 1000 * 30; // 30 seconds timeout
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
        if (!online) {
            return <Text style={{ color: '#999', fontSize: 14, marginLeft: 8 }}>Session disconnected</Text>
        }
        if (thinking) {
            return (
                <Text style={{ color: '#999', fontSize: 14, marginLeft: 8 }}>Thinking...</Text>
            )
        }
        return null
    }, [sessionId, online, thinking]);

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
                        {JSON.stringify('Hello world')}
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
                            <Text style={{ fontSize: 18, fontWeight: '600', lineHeight: 18 }}>/{getSessionName(session)}</Text>
                            <Text style={{ color: (online ? '#34C759' : '#999'), marginTop: 0, fontSize: 12 }}>{(online ? 'online' : lastSeenText)}</Text>
                        </View>
                    ),
                    headerRight(props) {
                        return (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                <Pressable
                                    onPress={() => setShowConfigModal(true)}
                                    hitSlop={10}
                                >
                                    <Avatar id={sessionId} size={32} monochrome={!online} />
                                </Pressable>
                            </View>
                        )
                    },
                }}
            />
            <KeyboardAvoidingView
                behavior="padding"
                keyboardVerticalOffset={safeArea.top + 44}
                style={{ flexGrow: 1, flexBasis: 0, marginBottom: safeArea.bottom }}
            >
                <View style={{ flexGrow: 1, flexBasis: 0 }}>
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
                </View>
                <AgentInput
                    placeholder="Type a message..."
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