import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import type { PendingMessage } from '@/sync/storageTypes';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { PendingMessagesModal } from './PendingMessagesModal';
import { layout } from '@/components/layout';

export function PendingUserTextMessageView(props: {
    sessionId: string;
    message: PendingMessage;
    otherPendingCount: number;
}) {
    const { theme } = useUnistyles();

    const badgeLabel = props.otherPendingCount > 0
        ? `Pending (+${props.otherPendingCount})`
        : 'Pending';

    return (
        <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
            <View style={styles.messageContent}>
                <View style={styles.userMessageContainer}>
                    <View style={[styles.userMessageBubble, { opacity: 0.85 }]}>
                        <Pressable
                            onPress={() => {
                                Modal.show({
                                    component: PendingMessagesModal,
                                    props: { sessionId: props.sessionId },
                                });
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={badgeLabel}
                            hitSlop={10}
                            style={({ pressed }) => ([
                                styles.pendingBadge,
                                {
                                    backgroundColor: theme.colors.input.background,
                                    opacity: pressed ? 0.85 : 1,
                                }
                            ])}
                        >
                            <Ionicons name="time-outline" size={14} color={theme.colors.textSecondary} />
                            <Text style={[styles.pendingBadgeText, { color: theme.colors.textSecondary }]}>
                                {badgeLabel}
                            </Text>
                        </Pressable>
                        <MarkdownView markdown={props.message.displayText || props.message.text} />
                    </View>
                </View>
            </View>
        </View>
    );
}


const styles = StyleSheet.create((theme) => ({
    messageContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    messageContent: {
        flexDirection: 'column',
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: layout.maxWidth,
    },
    userMessageContainer: {
        maxWidth: '100%',
        flexDirection: 'column',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
    },
    userMessageBubble: {
        backgroundColor: theme.colors.userMessageBackground,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        marginBottom: 12,
        maxWidth: '100%',
        position: 'relative',
    },
    pendingBadge: {
        position: 'absolute',
        top: -10,
        right: -10,
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 6,
        cursor: 'pointer',
    },
    pendingBadgeText: {
        marginLeft: 6,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
}));
