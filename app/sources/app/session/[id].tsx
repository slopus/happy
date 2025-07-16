import * as React from 'react';
import { syncEngine } from "@/sync/SyncEngine";
import { useRemoteClaudeCodeSession } from "@/sync/useRemoteClaudeCodeSession";
import { useRoute } from "@react-navigation/native";
import { useState } from "react";
import { FlatList, Text, TextInput, View, StyleSheet, Pressable, Button } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { ChatInput } from "@/components/ChatInput";
import { Stack, useRouter } from "expo-router";
import { formatLastSeen, getSessionName, isSessionOnline } from "@/utils/sessionUtils";
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from "@/components/Avatar";

export default function Session() {
    const safeArea = useSafeAreaInsets();
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const session = useRemoteClaudeCodeSession(sessionId);
    const [message, setMessage] = useState('');
    const online = isSessionOnline(session.session);
    const lastSeenText = formatLastSeen(session.session.active, session.session.activeAt);
    const thinking = session.session.thinking && session.session.thinkingAt > Date.now() - 1000 * 30; // 30 seconds timeout
    console.warn(session.session.agentState);
    const permissionRequest = React.useMemo(() => {
        let requests = session.session.agentState?.requests;
        if (!requests) {
            return null;
        }
        if (Object.keys(requests).length === 0) {
            return null;
        }
        return { id: Object.keys(requests)[0], call: requests[Object.keys(requests)[0]] };
    }, [session.session.agentState]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: () => (
                        <View style={{ flexDirection: 'column', alignItems: 'center', alignContent: 'center' }}>
                            <Text style={{ fontSize: 20, fontWeight: '600' }}>{getSessionName(session.session)}</Text>
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
                behavior="translate-with-padding"
                keyboardVerticalOffset={56}
                style={{ flex: 1, paddingBottom: safeArea.bottom }}
            >
                <FlatList
                    data={session.messages}
                    inverted={true}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <MessageView 
                            message={item} 
                            metadata={session.session.metadata}
                            onPress={() => router.push(`/session/${sessionId}/message/${item.id}`)}
                        />
                    )}
                    ListFooterComponent={() => <View style={{ height: 100 }} />}
                    ListHeaderComponent={() => <View style={{ height: 8 }} />}
                />
                {permissionRequest && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', height: 32, paddingHorizontal: 24 }}>
                        <Text style={{ color: '#666', fontSize: 14, marginLeft: 8 }}>Permission request</Text>
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
                <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                    <ChatInput
                        placeholder="Type a message..."
                        value={message}
                        onChangeText={setMessage}
                        onSend={() => {
                            syncEngine.getSession(sessionId).sendMessage(message);
                            setMessage('');
                        }}
                        loading={false}
                    />
                </View>
            </KeyboardAvoidingView>
            {/* 
            {!online && !overlayDismissed && (
                <Pressable
                    style={styles.offlineOverlay}
                    onPress={() => setOverlayDismissed(true)}
                >
                    <View style={styles.offlineCard}>
                        <Pressable
                            style={styles.closeButton}
                            onPress={() => setOverlayDismissed(true)}
                        >
                            <Ionicons name="close" size={24} color="#666" />
                        </Pressable>
                        <Ionicons name="information-circle-outline" size={48} color="#666" />
                        <Text style={styles.offlineTitle}>Session Probably Ended</Text>
                        <Text style={styles.offlineMessage}>
                            This session was last active {formatLastSeen(false, session.session.activeAt)}.
                        </Text>
                        <Text style={styles.offlineHint}>
                            The CLI might have been closed or disconnected.
                        </Text>
                    </View>
                </Pressable>
            )} */}
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