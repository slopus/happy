import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { RigGitSummary } from '@/sync/rig';
import { visibleRigGitLineChanges } from '@/utils/rigGitLineChanges';
import { GitLineChanges } from './GitLineChanges';

/** Compact line counts sourced exclusively from Happy Agent's encrypted session metadata. */
export const RigGitLineChanges = React.memo((summary: RigGitSummary) => {
    const visible = visibleRigGitLineChanges(summary);
    if (visible === null) return null;
    const styles = stylesheet;
    return (
        <View style={styles.container}>
            <GitLineChanges changes={visible} />
        </View>
    );
});

const stylesheet = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 'auto',
        paddingLeft: 8,
    },
});
