import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import type { RigGitSummary } from '@/sync/rig';
import { visibleRigGitLineChanges } from '@/utils/rigGitLineChanges';

/** Compact line counts sourced exclusively from Happy Agent's encrypted session metadata. */
export const RigGitLineChanges = React.memo((summary: RigGitSummary) => {
    const visible = visibleRigGitLineChanges(summary);
    if (visible === null) return null;
    const styles = stylesheet;
    return (
        <View style={styles.container}>
            {visible.approximate && <Text style={styles.approximate}>≈</Text>}
            {visible.insertions > 0 && (
                <Text style={styles.added}>+{visible.insertions}</Text>
            )}
            {visible.deletions > 0 && (
                <Text style={styles.removed}>-{visible.deletions}</Text>
            )}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 4,
        marginLeft: 'auto',
        paddingLeft: 8,
    },
    approximate: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 18,
        ...Typography.default('regular'),
    },
    added: {
        color: theme.colors.gitAddedText,
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    removed: {
        color: theme.colors.gitRemovedText,
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
}));
