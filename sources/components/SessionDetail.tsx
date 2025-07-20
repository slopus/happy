import * as React from 'react';
import { useState } from "react";
import { Text, View, FlatList } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";
import { ChatInput } from "@/components/ChatInput";
import { formatLastSeen, getSessionName, isSessionOnline } from "@/utils/sessionUtils";
import { Avatar } from "@/components/Avatar";
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import LottieView from 'lottie-react-native';

interface SessionDetailProps {
    sessionId: string;
}

export function SessionDetail({ sessionId }: SessionDetailProps) {
    const safeArea = useSafeAreaInsets();
    const session = useSession(sessionId);
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const [message, setMessage] = useState('');
    
    if (!session) {
        return (
            <View className="flex-1 items-center justify-center p-8">
                <Text className="text-gray-500 text-lg">Select a session to view</Text>
            </View>
        );
    }
    
    const online = isSessionOnline(session);
    const lastSeenText = formatLastSeen(session.active, session.activeAt);
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

    const handleSend = () => {
        if (message.trim()) {
            sync.sendMessage(sessionId, message);
            setMessage('');
        }
    };

    // Header for tablet view
    const header = (
        <View className="flex-row items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <View className="flex-row items-center flex-1">
                <Avatar id={sessionId} size={40} monochrome={!online} />
                <View className="ml-3 flex-1">
                    <Text className="text-lg font-semibold">{getSessionName(session)}</Text>
                    <Text className={online ? 'text-green-500 text-sm' : 'text-gray-500 text-sm'}>
                        {online ? 'online' : lastSeenText}
                    </Text>
                </View>
            </View>
        </View>
    );

    return (
        <View className="flex-1">
            {header}
            <KeyboardAvoidingView
                behavior="padding"
                keyboardVerticalOffset={0}
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
                            keyExtractor={(item) => item.id}
                            renderItem={({ item }) => (
                                <MessageView 
                                    message={item} 
                                    metadata={null}
                                    sessionId={sessionId}
                                />
                            )}
                            style={{ flexGrow: 1, flexBasis: 0 }}
                            contentContainerStyle={{ paddingVertical: 20 }}
                            inverted
                        />
                    )}
                    {permissionRequest && (
                        <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: '#eee' }}>
                            <Text style={{ fontSize: 16, marginBottom: 8 }}>Permission Request</Text>
                            <Text style={{ fontSize: 14, color: '#666' }}>{JSON.stringify(permissionRequest.call, null, 2)}</Text>
                        </View>
                    )}
                    {thinking && (
                        <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={{ color: '#666' }}>Claude is thinking...</Text>
                        </View>
                    )}
                </View>
                <ChatInput 
                    value={message}
                    onChangeText={setMessage}
                    onSend={handleSend}
                    loading={!online}
                    placeholder="Type a message..."
                />
            </KeyboardAvoidingView>
        </View>
    );
}