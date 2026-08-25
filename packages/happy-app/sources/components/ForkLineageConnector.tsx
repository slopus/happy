import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { FORK_INDENT_SIZE, FORK_MAX_VISUAL_DEPTH, forkIndentPadding } from '@/utils/forkLineage';

// Re-exported so renderer components can pull the indent helper alongside the
// connector from one place. The ordering/indent math lives in the pure,
// unit-tested `@/utils/forkLineage` module.
export { forkIndentPadding };

/**
 * An "└" tree connector linking a forked child row to its parent row directly
 * above it. Rendered absolutely inside the row, occupying the indent gap just
 * left of the row's content. Returns null for root rows (forkDepth 0).
 */
export function ForkLineageConnector({ forkDepth, rowHeight, basePadding }: {
    forkDepth: number;
    rowHeight: number;
    basePadding: number;
}) {
    if (forkDepth < 1) {
        return null;
    }
    const visualDepth = Math.min(forkDepth, FORK_MAX_VISUAL_DEPTH);
    const left = basePadding + (visualDepth - 1) * FORK_INDENT_SIZE + 4;
    return (
        <View
            pointerEvents="none"
            style={[
                styles.connector,
                { left, width: FORK_INDENT_SIZE - 6, height: Math.round(rowHeight / 2) },
            ]}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    connector: {
        position: 'absolute',
        top: 0,
        borderLeftWidth: 1.5,
        borderBottomWidth: 1.5,
        borderColor: theme.colors.divider,
        borderBottomLeftRadius: 5,
    },
}));
