import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { compactCount, type VisibleRigGitLineChanges } from '@/utils/rigGitLineChanges';

/** One count style across grouped/flat lists, the chat subtitle and session details. */
export const GitLineChanges = React.memo(({ changes }: { changes: VisibleRigGitLineChanges | null }) => {
    if (!changes) return null;
    return (
        <View style={styles.container}>
            {changes.approximate && <Text style={styles.approximate}>≈</Text>}
            {changes.insertions > 0 && <Text style={styles.added}>+{compactCount(changes.insertions)}</Text>}
            {changes.deletions > 0 && <Text style={styles.removed}>-{compactCount(changes.deletions)}</Text>}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 4,
    },
    approximate: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
    added: {
        color: theme.colors.gitAddedText,
        // Match the grouped project heading: regular Plex face, 11px, 600.
        // Selecting Plex's SemiBold face instead makes these noticeably heavier.
        fontSize: 11,
        fontWeight: '600',
    },
    removed: {
        color: theme.colors.gitRemovedText,
        fontSize: 11,
        fontWeight: '600',
    },
}));