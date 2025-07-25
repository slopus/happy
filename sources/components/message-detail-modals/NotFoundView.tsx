import * as React from 'react';
import { View, Text, Pressable } from "react-native";
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from "expo-router";

export function NotFoundView() {
    const router = useRouter();

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