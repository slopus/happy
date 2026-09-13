import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useSocketStatus } from '@/sync/storage';
import { t } from '@/text';
import { StatusDot } from './StatusDot';
import { shouldShowHomeConnectionStatus } from './homeConnectionStatus';

const statusLabels = {
    connected: 'status.connected',
    connecting: 'status.connecting',
    disconnected: 'status.disconnected',
    error: 'status.error',
} as const;

/** Center the title itself; connection status never participates in that layout. */
export const HomeHeaderTitle = React.memo(function HomeHeaderTitle({ title, subtitle }: { title: string; subtitle?: string }) {
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const showStatus = shouldShowHomeConnectionStatus(status, !!subtitle);
    const statusColor = theme.colors.status[status];

    return (
        <View style={styles.container} pointerEvents="none">
            <View style={styles.titleAnchor}>
                <Text style={styles.title} numberOfLines={1} accessibilityRole="header">{title}</Text>
                <View style={styles.subtitleSlot} testID="home-header-subtitle-slot">
                    {subtitle ? (
                        <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="middle">{subtitle}</Text>
                    ) : showStatus ? (
                        <View style={styles.status}>
                            <StatusDot color={statusColor} isPulsing={status === 'connecting'} size={6} style={styles.statusDot} />
                            <Text style={[styles.subtitle, { color: statusColor }]} numberOfLines={1}>
                                {t(statusLabels[status])}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignSelf: 'stretch',
        justifyContent: 'center',
        minWidth: 0,
    },
    titleAnchor: {
        position: 'relative',
        width: '100%',
        alignItems: 'center',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: Platform.OS === 'web' ? 17 : 16,
        fontWeight: '600',
        lineHeight: 20,
        color: theme.colors.header.tint,
        textAlign: 'center',
        maxWidth: '100%',
    },
    subtitleSlot: {
        // The header already has room for this line. Anchor it to the actual
        // title's bottom (including font scaling), not a measured screen offset.
        // Even the empty slot remains mounted, without recentering the title.
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        marginTop: -2,
        minHeight: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    subtitle: {
        ...Typography.default(),
        fontSize: Platform.OS === 'web' ? 12 : 11,
        fontWeight: '500',
        lineHeight: 16,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        maxWidth: '100%',
        textAlign: 'center',
    },
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        maxWidth: '100%',
    },
    statusDot: {
        marginRight: 4,
    },
}));