import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { View, ActivityIndicator, Text } from "react-native";
import { useSession, useSessionMessages, useSessionToolUse } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/Deferred";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolUseView } from '@/components/ToolUseView';
import { getToolUseState } from '@/components/transcriptUtils';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerTitle: {
        color: theme.colors.text,
        fontSize: 16,
        fontWeight: '600',
    },
    headerStatus: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
}));

export default React.memo(() => {
    const { id: sessionId, messageId, partId } = useLocalSearchParams<{ id: string; messageId: string; partId?: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const { isLoaded } = useSessionMessages(sessionId!);
    const toolUseRef = useSessionToolUse(sessionId!, messageId!, partId);
    const { theme } = useUnistyles();
    const styles = stylesheet;

    // Trigger session visibility when component mounts
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId]);

    // Navigate back if tool part doesn't exist after messages are loaded
    React.useEffect(() => {
        if (isLoaded && !toolUseRef) {
            router.back();
        }
    }, [isLoaded, toolUseRef, router]);

    // Show loader while waiting for session and messages to load
    if (!session || !isLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (!toolUseRef) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    const toolState = getToolUseState(toolUseRef.toolUse, toolUseRef.toolResult);
    const statusText = toolState === 'running' ? 'Running' : toolState === 'error' ? 'Failed' : 'Completed';

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: () => <Text style={styles.headerTitle}>{toolUseRef.toolUse.name}</Text>,
                    headerRight: () => <Text style={styles.headerStatus}>{statusText}</Text>,
                    headerStyle: {
                        backgroundColor: theme.colors.header.background,
                    },
                    headerTintColor: theme.colors.header.tint,
                    headerShadowVisible: false,
                }}
            />
            <Deferred>
                <ToolUseView
                    toolUse={toolUseRef.toolUse}
                    toolResult={toolUseRef.toolResult}
                    sessionId={sessionId!}
                    messageId={messageId!}
                    metadata={session.metadata}
                    expanded={true}
                />
            </Deferred>
        </>
    );
});
