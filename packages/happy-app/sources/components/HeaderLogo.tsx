import * as React from 'react';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useSocketStatus } from '@/sync/storage';

/**
 * Shared header logo component used across all main tabs.
 * Extracted to prevent flickering on tab switches - when each tab
 * had its own HeaderLeft, the component would unmount/remount.
 */
export const HeaderLogo = React.memo(() => {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();

    const statusColor = (() => {
        switch (socketStatus.status) {
            case 'connected': return theme.colors.status.connected;
            case 'connecting': return theme.colors.status.connecting;
            case 'disconnected': return theme.colors.status.disconnected;
            case 'error': return theme.colors.status.error;
            default: return theme.colors.status.default;
        }
    })();

    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        }}>
            <StatusDot
                color={statusColor}
                isPulsing={socketStatus.status === 'connecting'}
                size={8}
            />
            <Text style={{
                fontSize: 15,
                letterSpacing: 2,
                textTransform: 'uppercase',
                color: theme.colors.header.tint,
                ...Typography.brand(),
            }}>chatai.304</Text>
        </View>
    );
});
