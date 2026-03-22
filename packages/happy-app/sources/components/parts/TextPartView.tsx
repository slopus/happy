import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type v3 } from '@slopus/happy-sync';
import { MarkdownView, Option } from '../markdown/MarkdownView';
import { sync } from '@/sync/sync';

export const TextPartView = React.memo((props: {
    part: v3.TextPart;
    sessionId: string;
}) => {
    const { part, sessionId } = props;

    const handleOptionPress = React.useCallback((option: Option) => {
        sync.sendMessage(sessionId, option.title);
    }, [sessionId]);

    // Synthetic/ignored text parts are hidden
    if (part.synthetic || part.ignored) {
        return null;
    }

    return (
        <View style={styles.container}>
            <MarkdownView markdown={part.text} onOptionPress={handleOptionPress} sessionId={sessionId} />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 16,
        alignSelf: 'flex-start',
    },
}));
