import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import { useSession, useV3SessionMessages, useV3ToolPart } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/Deferred";
import { ToolPartHeader, ToolPartStatusIndicator, ToolPartView } from '@/components/parts/ToolPartView';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullViewContainer: {
        flex: 1,
        padding: 16,
    },
    messageText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
        ...Typography.default(),
    },
}));

export default React.memo(() => {
    const { id: sessionId, messageId, partId } = useLocalSearchParams<{ id: string; messageId: string; partId?: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const { isLoaded } = useV3SessionMessages(sessionId!);
    const toolPart = useV3ToolPart(sessionId!, messageId!, partId);
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
        if (isLoaded && !toolPart) {
            router.back();
        }
    }, [isLoaded, toolPart, router]);

    // Show loader while waiting for session and messages to load
    if (!session || !isLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (!toolPart) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: () => <ToolPartHeader part={toolPart} />,
                    headerRight: () => <ToolPartStatusIndicator part={toolPart} />,
                    headerStyle: {
                        backgroundColor: theme.colors.header.background,
                    },
                    headerTintColor: theme.colors.header.tint,
                    headerShadowVisible: false,
                }}
            />
            <Deferred>
                <ToolPartView
                    part={toolPart}
                    sessionId={sessionId!}
                    messageId={messageId!}
                    expanded
                />
            </Deferred>
        </>
    );
});
