import * as React from 'react';
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { View, Text, Pressable, Platform } from "react-native";
import { Ionicons } from '@expo/vector-icons';
import { useMessage } from "@/sync/storage";
import { MessageDetailView, getMessageDetailTitle } from "@/components/MessageDetailView";
import { Deferred } from "@/components/Deferred";

export default React.memo(() => {
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const router = useRouter();
    const message = useMessage(sessionId!, messageId!);

    if (message === null) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                <Stack.Screen
                    options={{
                        title: "Message Not Found",
                        headerRight: () => (
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

    // Get the appropriate title using the helper function
    const title = getMessageDetailTitle(message);
    console.log("!!!!!! we should be showing the title ", title);

    return (
        <View style={{ flex: 1, backgroundColor: 'white' }}>
            <Stack.Screen
                options={{
                    title,
                    headerRight: Platform.OS === 'ios' ? () => (
                        <Pressable onPress={() => router.back()} hitSlop={10}>
                            <Ionicons name="close" size={24} color="#000" />
                        </Pressable>
                    ) : undefined,
                }}
            />

            <Deferred>
                <MessageDetailView message={message} messageId={messageId!} sessionId={sessionId!} />
            </Deferred>
        </View>
    );
});
