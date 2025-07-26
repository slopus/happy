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
    const tools = message.tools;

    // Determine title based on tools
    const getTitle = () => {
        if (tools && tools.length > 0) {
            // If there's only one tool, use that tool's name
            if (tools.length === 1) {
                const toolName = tools[0].name;
                return `${toolName} Details`;
            }
            // If multiple tools, use generic "Tool Details"
            return "Tool Details";
        }
        return "Tool Details";
    };

    if (tools.length === 0) {
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
                {tools.map((tool, index) => (
                    <View
                        key={index}
                        style={{ marginBottom: index < tools.length - 1 ? 20 : 0 }}
                    >
                        <DetailedToolBlock tool={tool} metadata={session?.metadata || null} />
                    </View>
                ))}
            </ScrollView>
        </View>
    );
} 