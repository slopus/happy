import React from "react";
import { View, Text, ScrollView, Pressable, Platform, Linking, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from "expo-router";
import { type ToolCallMessage } from "@/sync/typesMessage";
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import * as Clipboard from 'expo-clipboard';

interface EmptyToolsArrayViewProps {
    message: ToolCallMessage;
    sessionId: string;
}

export function EmptyToolsArrayView({ message, sessionId }: EmptyToolsArrayViewProps) {
    const safeArea = useSafeAreaInsets();
    const router = useRouter();

    const getIssueContent = () => {
        const debugInfo = {
            messageId: message.id,
            sessionId: sessionId,
            messageKind: message.kind,
            hasToolCall: message.tool !== null,
            createdAt: message.createdAt
        };

        const title = "Bug Report: ToolCallMessage with No Tool";
        const body = `## Bug Description
A data model inconsistency was detected: A message with \`kind: "tool-call"\`
exists but has no tool.

The application navigated to the message detail route
\`(app)/session/[id]/message/[messageId].tsx\` to display details for a
ToolCallMessage, but the message's \`tool\` is null. This should be
impossible according to the intended data model.

## Root Cause
- The data model allows \`Message[kind] === "tool-call"\` to have a null tool
- This state should be impossible but is not currently enforced at the type level
- Navigation to message details has no type checking, so invalid states can be reached

## What Should Happen
- ToolCallMessage should never exist with a null tool

## Current Behavior
- User navigates to a message detail view
- App discovers the ToolCallMessage has no actual tool calls to display
- Shows this error screen instead of crashing

## Steps to Reproduce
[Please describe the steps you took to get to this screen]

## Debug Information
\`\`\`json
${JSON.stringify(debugInfo, null, 2)}
\`\`\`
`;

        return { title, body };
    };

    const handleReportIssue = async () => {
        const { title, body } = getIssueContent();
        const url = `https://github.com/slopus/happy/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
        
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        } else {
            Alert.alert('Error', 'Could not open GitHub. Please visit https://github.com/slopus/happy/issues manually.');
        }
    };

    const handleCopyIssueReport = async () => {
        const { title, body } = getIssueContent();
        const fullReport = `# ${title}\n\n${body}`;
        
        await Clipboard.setStringAsync(fullReport);
        Alert.alert('Copied!', 'Issue report copied to clipboard');
    };

    return (
        <View style={{ flex: 1, backgroundColor: "#F2F2F7" }}>
            <Stack.Screen
                options={{
                    title: "Unreachable Route",
                    headerShadowVisible: true,
                    headerRight: Platform.OS === 'ios' ? () => (
                        <Pressable onPress={() => router.back()} hitSlop={10}>
                            <Ionicons name="close" size={24} color="#000" />
                        </Pressable>
                    ) : undefined,
                }}
            />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ 
                    paddingBottom: safeArea.bottom + 20,
                }}
            >
                {/* Original Error Message */}
                <View style={{ padding: 20, backgroundColor: 'white' }}>
                    <Text style={{
                        fontSize: 16,
                        lineHeight: 24,
                        color: '#1C1C1E',
                        marginBottom: 8,
                        ...Typography.default('regular')
                    }}>
                        I thought it was impossible to navigate to this screen!
                    </Text>
                    <Text style={{
                        fontSize: 16,
                        fontWeight: '600',
                        color: '#1C1C1E',
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        What happened?
                    </Text>
                    
                    <Text style={{
                        fontSize: 16,
                        lineHeight: 24,
                        color: '#1C1C1E',
                        marginBottom: 16,
                        ...Typography.default('regular')
                    }}>
                        You're seeing this because I tried to show you details about a tool call, but the array of tool calls is empty. This route should only be reachable when there are actual tool calls to display, so something has gone wrong in the navigation logic.
                    </Text>
                </View>

                {/* Bug Report Section */}
                <ItemGroup title="Help Us Fix This" footer="You've found a bug! Please report it so we can fix it for everyone.">
                    <Item 
                        title="Report Issue on GitHub"
                        subtitle="Creates a pre-filled bug report"
                        icon={<Ionicons name="bug-outline" size={29} color="#FF3B30" />}
                        onPress={handleReportIssue}
                    />
                    <Item 
                        title="Copy Issue Report"
                        subtitle="Copy markdown to clipboard"
                        icon={<Ionicons name="copy-outline" size={29} color="#34C759" />}
                        onPress={handleCopyIssueReport}
                    />
                </ItemGroup>
            </ScrollView>
        </View>
    );
} 