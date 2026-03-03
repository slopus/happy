import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { StatusDot } from './StatusDot';
import { useSocketStatus } from '@/sync/storage';

/**
 * Shared header logo component used across all main tabs.
 * Shows a minimal status dot instead of text branding.
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
        }}>
            <StatusDot
                color={statusColor}
                isPulsing={socketStatus.status === 'connecting'}
                size={8}
            />
        </View>
    );
});
