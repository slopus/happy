import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { OrchestratorRunSummary } from '@/sync/apiOrchestrator';

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        height: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHighest,
        overflow: 'hidden',
        flexDirection: 'row',
    },
}));

export const OrchestratorProgressBar = React.memo(({ summary }: { summary: OrchestratorRunSummary }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { total } = summary;

    if (total === 0) {
        return <View style={styles.track} />;
    }

    const segments: Array<{ fraction: number; color: string }> = [
        { fraction: summary.completed / total, color: theme.colors.status.connected },
        { fraction: summary.failed / total, color: theme.colors.status.error },
        { fraction: summary.running / total, color: theme.colors.status.connecting },
        { fraction: summary.cancelled / total, color: theme.colors.textSecondary },
    ];

    return (
        <View style={styles.track}>
            {segments.map((seg, i) =>
                seg.fraction > 0 ? (
                    <View
                        key={i}
                        style={{
                            flex: seg.fraction,
                            height: 8,
                            backgroundColor: seg.color,
                        }}
                    />
                ) : null,
            )}
        </View>
    );
});
