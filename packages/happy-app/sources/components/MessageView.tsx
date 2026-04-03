import type { Metadata } from '@/sync/storageTypes';
import type { SessionMessage } from '@slopus/happy-sync';
import * as React from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView, type Option } from './markdown/MarkdownView';
import { layout } from './layout';
import { AgentContentView } from './AgentContentView';
import { getUserContentImages, getUserContentMarkdown, isUserMessage } from './transcriptUtils';
import { sync } from '@/sync/sync';

export interface MessageViewProps {
    message: SessionMessage;
    sessionId: string;
    messageId: string;
    metadata?: Metadata | null;
}

export const MessageView = React.memo<MessageViewProps>(({ message, sessionId, messageId, metadata }) => {
    const handleOptionPress = React.useCallback((option: Option) => {
        sync.sendMessage(sessionId, option.title);
    }, [sessionId]);

    if (message === 'Resume') {
        return (
            <View style={styles.messageContainer}>
                <View style={styles.messageContent}>
                    <View style={styles.resumePill}>
                        <Text style={styles.resumeText}>Resumed session</Text>
                    </View>
                </View>
            </View>
        );
    }

    if (isUserMessage(message)) {
        const markdown = getUserContentMarkdown(message.User.content);
        const images = getUserContentImages(message.User.content);

        if (!markdown && images.length === 0) {
            return null;
        }

        return (
            <View style={styles.messageContainer}>
                <View style={styles.messageContent}>
                    <View style={styles.userMessageContainer}>
                        <View style={styles.userMessageBubble}>
                            {markdown ? (
                                <MarkdownView markdown={markdown} onOptionPress={handleOptionPress} sessionId={sessionId} />
                            ) : null}
                            {images.map((image, index) => (
                                <Image
                                    key={`image:${index}`}
                                    source={{ uri: image.source }}
                                    style={[
                                        styles.userImage,
                                        image.size?.width && image.size?.height
                                            ? { aspectRatio: image.size.width / image.size.height }
                                            : null,
                                    ]}
                                />
                            ))}
                        </View>
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.messageContainer}>
            <View style={styles.messageContent}>
                <AgentContentView
                    content={message.Agent.content}
                    toolResults={message.Agent.tool_results}
                    sessionId={sessionId}
                    messageId={messageId}
                    metadata={metadata}
                />
            </View>
        </View>
    );
});

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
        gap: 8,
    },
    userImage: {
        width: 220,
        maxWidth: '100%',
        height: 180,
        borderRadius: 8,
    },
    resumePill: {
        alignSelf: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
        marginBottom: 12,
    },
    resumeText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
    },
}));
