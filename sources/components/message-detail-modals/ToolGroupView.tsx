import React from "react";
import { View, Text, ScrollView, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from "expo-router";
import { type ToolCallGroupMessage, type ToolCallMessage } from "@/sync/typesMessage";
import { DetailedToolBlock } from "@/components/blocks/RenderToolCallV4";
import { useSession, useMessage } from "@/sync/storage";

interface ToolGroupViewProps {
    toolCallMessages: ToolCallMessage[];
    sessionId: string;
}

export function ToolGroupView({ toolCallMessages, sessionId }: ToolGroupViewProps) {
    const safeArea = useSafeAreaInsets();
    const session = useSession(sessionId);
    const router = useRouter();

    const title = `Tool Group (${toolCallMessages.length} tools)`;

    return (
        <View style={{ flex: 1, backgroundColor: "white" }}>
            <Stack.Screen options={{ title }} />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
            >
                <View
                    style={{
                        backgroundColor: "#f8f9fa",
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: 1,
                        borderBottomColor: "#e0e0e0",
                    }}
                >
                    <Text style={{ fontSize: 16, fontWeight: '600', color: '#333', marginBottom: 4 }}>
                        Tool Call Group
                    </Text>
                    <Text style={{ fontSize: 12, color: "#666" }}>
                        {toolCallMessages.length} tool call{toolCallMessages.length !== 1 ? 's' : ''}
                    </Text>
                </View>

                {toolCallMessages.map((toolMsg, index) => (
                    <View key={toolMsg.id} style={{ margin: 16 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 8, color: '#666' }}>
                            Tool Call {index + 1}
                        </Text>
                        {toolMsg.tools.map((tool, toolIndex) => (
                            <View key={toolIndex} style={{ marginBottom: toolIndex < toolMsg.tools.length - 1 ? 20 : 0 }}>
                                <DetailedToolBlock tool={tool} metadata={session?.metadata || null} />
                            </View>
                        ))}
                    </View>
                ))}
            </ScrollView>
        </View>
    );
} 