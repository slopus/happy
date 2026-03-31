/**
 * V3MessageView — renders a MessageWithParts by dispatching each Part
 * to a PartView. This is the v3 replacement for MessageView.
 *
 * User messages render as bubbles (matching legacy UserTextBlock).
 * Assistant messages render parts sequentially.
 */
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type v3 } from '@slopus/happy-sync';
import { PartView } from './PartView';
import { FilePartView } from './FilePartView';
import { MarkdownView, Option } from '../markdown/MarkdownView';
import { layout } from '../layout';
import { sync } from '@/sync/sync';

export const V3MessageView = React.memo((props: {
    message: v3.MessageWithParts;
    sessionId: string;
}) => {
    const { message, sessionId } = props;
    const messageId = message.info.id as string;

    if (message.info.role === 'user') {
        return <UserMessageView message={message} sessionId={sessionId} />;
    }

    return (
        <View style={styles.messageContainer}>
            <View style={styles.messageContent}>
                {message.parts.map((part) => (
                    <PartView
                        key={part.id as string}
                        part={part}
                        sessionId={sessionId}
                        messageId={messageId}
                    />
                ))}
            </View>
        </View>
    );
});

const UserMessageView = React.memo((props: {
    message: v3.MessageWithParts;
    sessionId: string;
}) => {
    const { message, sessionId } = props;
    const userInfo = message.info as v3.UserMessage;
    const handleOptionPress = React.useCallback((option: Option) => {
        sync.sendMessage(sessionId, option.title);
    }, [sessionId]);

    // Extract text and file parts
    const text = message.parts
        .filter((p): p is v3.TextPart => p.type === 'text')
        .map(p => p.text)
        .join('\n');

    const fileParts = message.parts.filter((p): p is v3.FilePart => p.type === 'file');

    if (!text && fileParts.length === 0) return null;

    const renderedText = userInfo.meta?.displayText ?? text;

    return (
        <View style={styles.messageContainer}>
            <View style={styles.messageContent}>
                <View style={styles.userMessageContainer}>
                    {fileParts.length > 0 && fileParts.map(fp => (
                        <FilePartView key={fp.id as string} part={fp} sessionId={sessionId} />
                    ))}
                    {text ? (
                        <View style={styles.userMessageBubble}>
                            <MarkdownView markdown={renderedText} onOptionPress={handleOptionPress} sessionId={sessionId} />
                        </View>
                    ) : null}
                </View>
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
        paddingVertical: 4,
        borderRadius: 12,
        marginBottom: 12,
        maxWidth: '100%',
    },
}));
