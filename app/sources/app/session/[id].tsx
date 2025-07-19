import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { useState } from "react";
import { Text, View, StyleSheet, Button, FlatList } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { ChatInput } from "@/components/ChatInput";
import { Stack, useRouter } from "expo-router";
import { formatLastSeen, getSessionName, isSessionOnline } from "@/utils/sessionUtils";
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import LottieView from 'lottie-react-native';

export default function Session() {
    const safeArea = useSafeAreaInsets();
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const session = useSession(sessionId)!;
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    const online = isSessionOnline(session);
    const lastSeenText = formatLastSeen(session.active, session.activeAt);
    const thinking = session.thinking && session.thinkingAt > Date.now() - 1000 * 30; // 30 seconds timeout
    console.warn(session.agentState);
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

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: () => (
                        <View style={{ flexDirection: 'column', alignItems: 'center', alignContent: 'center' }}>
                            <Text style={{ fontSize: 20, fontWeight: '600' }}>{getSessionName(session)}</Text>
                            <Text style={{ color: (online ? '#34C759' : '#999') }}>{(online ? 'online' : lastSeenText)}</Text>
                        </View>
                    ),
                    headerRight(props) {
                        return (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Avatar id={sessionId} size={32} monochrome={!online} />
                            </View>
                        )
                    },
                }}
            />
            <KeyboardAvoidingView
                behavior="padding"
                keyboardVerticalOffset={56}
                style={{ flexGrow: 1, flexBasis: 0 }}
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
                            ListHeaderComponent={() => <View style={{ height: 8 }} />}
                            ListFooterComponent={() => <View style={{ height: 8 }} />}
                        />
                    )}
                </View>
                {permissionRequest && (
                    <View style={{ flexDirection: 'column', justifyContent: 'space-between', height: 128, paddingHorizontal: 24 }}>
                        <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>Permission request</Text>
                        <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>{permissionRequest.call.tool}</Text>
                        <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>{JSON.stringify(permissionRequest.call.arguments)}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Button title="Deny" onPress={() => sync.deny(sessionId, permissionRequest.id)} />
                            <Button title="Allow" onPress={() => sync.allow(sessionId, permissionRequest.id)} />
                        </View>
                    </View>
                )}
                {/* <Button title="Abort" onPress={() => session.abort()} /> */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', height: 32, paddingHorizontal: 24 }}>
                    {!online && (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Ionicons name="information-circle-outline" size={16} color="#666" />
                            <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>Session disconnected</Text>
                        </View>
                    )}
                    {online && thinking && (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>Thinking...</Text>
                        </View>
                    )}
                    {online && !thinking && (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>Awaiting command.</Text>
                        </View>
                    )}
                </View>
                <View style={{ paddingHorizontal: 16, paddingBottom: 16 + safeArea.bottom }}>
                    <ChatInput
                        placeholder="Type a message..."
                        value={message}
                        onChangeText={setMessage}
                        onSend={() => {
                            sync.sendMessage(sessionId, message);
                            setMessage('');
                        }}
                        loading={false}
                    />
                </View>
            </KeyboardAvoidingView>
        </>
    )
}

const styles = StyleSheet.create({
    offlineOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    offlineCard: {
        backgroundColor: 'white',
        borderRadius: 16,
        padding: 32,
        alignItems: 'center',
        maxWidth: 320,
        width: '100%',
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.25,
        shadowRadius: 8,
        elevation: 5,
    },
    closeButton: {
        position: 'absolute',
        top: 12,
        right: 12,
        padding: 8,
        borderRadius: 20,
        backgroundColor: '#f5f5f5',
    },
    offlineTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: '#000',
        marginTop: 16,
        marginBottom: 8,
        textAlign: 'center',
    },
    offlineMessage: {
        fontSize: 16,
        color: '#666',
        textAlign: 'center',
        marginBottom: 8,
    },
    offlineHint: {
        fontSize: 14,
        color: '#999',
        textAlign: 'center',
        fontStyle: 'italic',
    },
});