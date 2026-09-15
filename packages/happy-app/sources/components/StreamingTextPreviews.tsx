import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { SessionTextPreview } from '@/sync/sessionTextStream';
import { layout } from './layout';

/**
 * Uncommitted output is deliberately read-only. Do not send partial structured
 * blocks through the normal message renderer: options, OTA cards and message
 * actions belong to the durable answer, not an unfinished provider snapshot.
 * Staying in the transcript footer also keeps previews out of history anchors.
 */
export const StreamingTextPreviews = React.memo((props: { previews: readonly SessionTextPreview[] }) => {
    if (props.previews.length === 0) return null;
    return <View testID="session-stream-previews" style={styles.container}>
        <View style={styles.content}>
            {props.previews.map(preview => <Text
                key={JSON.stringify([preview.sessionId, preview.turnId, preview.itemId])}
                testID="session-stream-preview-text"
                selectable
                style={styles.text}
            >{preview.text}</Text>)}
        </View>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    container: { flexDirection: 'row', justifyContent: 'center' },
    content: { flex: 1, minWidth: 0, maxWidth: layout.maxWidth },
    text: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
        marginHorizontal: 16,
        marginBottom: 12,
    },
}));
