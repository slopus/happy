import React from "react";
import { View, Text, ScrollView, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from "expo-router";
import { type ToolCallMessage } from "@/sync/typesMessage";
import { DetailedToolBlock } from "@/components/blocks/RenderToolCallV4";
import { useSession } from "@/sync/storage";

interface ToolCallViewProps {
    message: ToolCallMessage;
    sessionId: string;
}

export function ToolCallView({ message, sessionId }: ToolCallViewProps) {
    const safeArea = useSafeAreaInsets();
    const session = useSession(sessionId);
    const router = useRouter();
    const tool = message.tool;

    // Determine title based on tool
    const getTitle = () => {
        if (tool) {
            const toolName = tool.name;
            return `${toolName} Details`;
        }
        return "Tool Details";
    };

    if (!tool) {
        // return <EmptyToolCallView message={message} sessionId={sessionId} />;
        return null;
    }

    return (
        <View style={{ flex: 1, backgroundColor: "white" }}>
            <Stack.Screen
                options={{
                    title: getTitle(),
                    headerRight: Platform.OS === 'ios' ? () => (
                        <Pressable onPress={() => router.back()} hitSlop={10}>
                            <Ionicons name="close" size={24} color="#000" />
                        </Pressable>
                    ) : undefined,
                }}
            />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
            >
                <DetailedToolBlock tool={tool} metadata={session?.metadata || null} />
                
                {/* Render children if any */}
                {message.children && message.children.length > 0 && (
                    <View style={{ marginTop: 20 }}>
                        <Text style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 10 }}>Child Operations:</Text>
                        {message.children.map((child, index) => (
                            <View key={child.id} style={{ marginBottom: 10 }}>
                                {child.kind === 'tool-call' && (
                                    <Text>{child.tool.name}</Text>
                                )}
                                {child.kind === 'agent-text' && (
                                    <Text numberOfLines={2}>{child.text}</Text>
                                )}
                            </View>
                        ))}
                    </View>
                )}
            </ScrollView>
        </View>
    );
} 