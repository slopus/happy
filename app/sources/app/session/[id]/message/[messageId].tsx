import { useOneMessage, useRemoteClaudeCodeSession } from "@/sync/useRemoteClaudeCodeSession";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { Ionicons } from '@expo/vector-icons';

export default function MessageModal() {
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    // TODO refactor how information is passed around such that we don't need to
    // get information about the session metadata object just to show the
    // message. I'm thinking that each message object should contain all the
    // information required to renderitself at all times.
    const session = useRemoteClaudeCodeSession(sessionId!);
    const message = useOneMessage(sessionId!, messageId!);

    if (message === null) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                <Stack.Screen
                    options={{
                        title: "Message Not Found",
                        headerLeft: () => (
                            <Pressable onPress={() => router.back()} hitSlop={10}>
                                <Ionicons name="close" size={24} color="#000" />
                            </Pressable>
                        )
                    }}
                />
                <Ionicons name="document-text-outline" size={64} color="#ccc" />
                <Text style={{ fontSize: 18, color: '#666', textAlign: 'center', marginTop: 16 }}>
                    Message not found
                </Text>
                <Text style={{ fontSize: 14, color: '#999', textAlign: 'center', marginTop: 8 }}>
                    This message may have been deleted or doesn't exist in this session.
                </Text>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: 'white' }}>
            <Stack.Screen
                options={{
                    title: "Message Details",
                    headerLeft: () => (
                        <Pressable onPress={() => router.back()} hitSlop={10}>
                            <Ionicons name="close" size={24} color="#000" />
                        </Pressable>
                    )
                }}
            />
            
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}>
                {/* Message Header */}
                <View style={{ 
                    backgroundColor: '#f8f9fa', 
                    paddingHorizontal: 16, 
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: '#e0e0e0'
                }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, color: '#666' }}>
                            Message ID: {messageId}
                        </Text>
                        <Text style={{ fontSize: 12, color: '#666' }}>
                            {message.content?.role === 'user' ? 'User' : 'Assistant'}
                        </Text>
                    </View>
                </View>

                {/* Message Content */}
                <View style={{ flex: 1, paddingTop: 8 }}>
                    <MessageView 
                        message={message} 
                        metadata={session.session.metadata} 
                    />
                </View>
                
                {/* Debug Information (Optional) */}
                <View style={{ 
                    margin: 16, 
                    padding: 12, 
                    backgroundColor: '#f8f9fa', 
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: '#e0e0e0'
                }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 8, color: '#666' }}>
                        Message Details
                    </Text>
                    <Text style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
                        Local ID: {message.id}
                    </Text>
                    {message.serverId && (
                        <Text style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
                            Server ID: {message.serverId}
                        </Text>
                    )}
                    {message.content && (
                        <Text style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
                            Role: {message.content.role}
                        </Text>
                    )}
                    {message.content && 'type' in message.content && (
                        <Text style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
                            Content Type: {String((message.content as any).type)}
                        </Text>
                    )}
                </View>
            </ScrollView>
        </View>
    );
} 