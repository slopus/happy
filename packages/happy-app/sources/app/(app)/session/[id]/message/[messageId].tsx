import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Text, View, ActivityIndicator, Platform, Pressable, useWindowDimensions } from "react-native";
import { useMessage, useSession, useSessionMessages } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/Deferred";
import { ToolFullView } from '@/components/tools/ToolFullView';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/ToolStatusIndicator';
import { Message } from '@/sync/typesMessage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { layout } from '@/components/layout';
import { LongPressCopy, useCopySelectable } from '@/components/LongPressCopy';

// Header button width constants
const HEADER_BUTTON_WIDTH = 60;
const HEADER_PADDING = Platform.OS === 'ios' ? 16 : 32;
const HEADER_CENTER_PADDING = 24;

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
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const { isLoaded: messagesLoaded } = useSessionMessages(sessionId!);
    const message = useMessage(sessionId!, messageId!);
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width: screenWidth } = useWindowDimensions();

    // Left: back button (1), Right: status indicator (1)
    // Use the smaller of screenWidth and headerMaxWidth to account for max-width constraint
    const effectiveHeaderWidth = Math.min(screenWidth, layout.headerMaxWidth);
    const headerTitleMaxWidth = effectiveHeaderWidth - (HEADER_BUTTON_WIDTH * 2) - HEADER_PADDING - HEADER_CENTER_PADDING;
    
    // Trigger session visibility when component mounts
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId, true);
        }
    }, [sessionId]);
    
    // Navigate back if message doesn't exist after messages are loaded
    React.useEffect(() => {
        if (messagesLoaded && !message) {
            router.back();
        }
    }, [messagesLoaded, message, router]);
    
    // Configure header for tool messages
    React.useLayoutEffect(() => {
        if (message && message.kind === 'tool-call' && message.tool) {
            // Header is configured in the Stack.Screen options
        }
    }, [message]);
    
    // Show loader while waiting for session and messages to load
    if (!session || !messagesLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    // If messages are loaded but specific message not found, show loader briefly
    // The useEffect above will navigate back
    if (!message) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    return (
        <>
            {message && message.kind === 'tool-call' && message.tool && (
                <Stack.Screen
                    options={{
                        headerLeft: () => (
                            <Pressable
                                onPress={() => router.back()}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                            >
                                <Ionicons
                                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                    size={Platform.OS === 'ios' ? 28 : 24}
                                    color={theme.colors.header.tint}
                                />
                            </Pressable>
                        ),
                        headerTitle: () => <ToolHeader tool={message.tool} maxWidth={headerTitleMaxWidth} />,
                        headerRight: () => <ToolStatusIndicator tool={message.tool} />,
                        headerStyle: {
                            backgroundColor: theme.colors.header.background,
                        },
                        headerTintColor: theme.colors.header.tint,
                        headerShadowVisible: false,
                    }}
                />
            )}
            <Deferred>
                <FullView message={message} />
            </Deferred>
        </>
    );
});

function FullView(props: { message: Message }) {
    const styles = stylesheet;
    const selectable = useCopySelectable();

    if (props.message.kind === 'tool-call') {
        return <ToolFullView tool={props.message.tool} messages={props.message.children} />
    }
    if (props.message.kind === 'agent-text') {
        return (
            <LongPressCopy text={props.message.text}>
                <View style={styles.fullViewContainer}>
                    <Text selectable={selectable} style={styles.messageText}>{props.message.text}</Text>
                </View>
            </LongPressCopy>
        )
    }
    if (props.message.kind === 'user-text') {
        return (
            <LongPressCopy text={props.message.text}>
                <View style={styles.fullViewContainer}>
                    <Text selectable={selectable} style={styles.messageText}>{props.message.text}</Text>
                </View>
            </LongPressCopy>
        )
    }
    return null;
}