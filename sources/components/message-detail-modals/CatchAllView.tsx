import React from "react";
import { View, Text, ScrollView, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from "expo-router";
import { type Message } from "@/sync/typesMessage";
import { InfoBox } from "@/components/atoms/InfoBox";

interface KeyValueTextProps {
    label: string;
    value: string;
}

function KeyValueText({ label, value }: KeyValueTextProps) {
    return (
        <Text style={{ fontSize: 12, color: "#666" }}>
            {label}: {value}
        </Text>
    );
}

interface CatchAllViewProps {
    message: Message,
}

export function CatchAllView({ message }: CatchAllViewProps) {
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const messageId = message.id;

    const getTitle = () => {
        switch (message.kind) {
            case 'user-text':
                return "User Message";
            case 'agent-text':
                return "Assistant Message";
            default:
                return "Message Details";
        }
    };

    return (
        <View style={{ flex: 1, backgroundColor: "white" }}>
            <Stack.Screen
                options={{ title: getTitle() }}
            />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
            >
                {/* Debug header showing message metadata */}
                <View
                    style={{
                        backgroundColor: "#f8f9fa",
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: 1,
                        borderBottomColor: "#e0e0e0",
                    }}
                >
                    <View
                        style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            alignItems: "center",
                        }}
                    >
                        <Text style={{ fontSize: 12, color: "#666" }}>
                            Message ID: {messageId}
                        </Text>
                        <Text style={{ fontSize: 12, color: "#666" }}>
                            Kind: {message.kind}
                        </Text>
                    </View>
                </View>

                <InfoBox title="Debug Information" variant="info" className="mt-4 mx-4 mb-4">
                    <KeyValueText label="Local ID" value={message.id} />
                    <KeyValueText label="Kind" value={message.kind} />
                    <KeyValueText label="Created At" value={new Date(message.createdAt).toLocaleString()} />
                </InfoBox>

                <InfoBox title="Message Content">
                    {(message.kind === 'user-text' || message.kind === 'agent-text') && (
                        <Text style={{ fontSize: 14, lineHeight: 20, color: "#333" }}>
                            {message.text}
                        </Text>
                    )}
                    {/* Fallback for unknown message types */}
                    {!['user-text', 'agent-text'].includes(message.kind) && (
                        <Text style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
                            {JSON.stringify(message, null, 2)}
                        </Text>
                    )}
                </InfoBox>
            </ScrollView>
        </View>
    );
} 