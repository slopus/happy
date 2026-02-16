import * as React from 'react';
import { View, Text } from 'react-native';
import { useRealtimeStatus, useRealtimeMode } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { VoiceBars } from '@/components/VoiceBars';

function formatElapsed(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export const VoiceActivityBar = React.memo(() => {
    const { theme } = useUnistyles();
    const realtimeStatus = useRealtimeStatus();
    const realtimeMode = useRealtimeMode();

    // Elapsed timer since connected
    const [elapsed, setElapsed] = React.useState(0);
    React.useEffect(() => {
        if (realtimeStatus !== 'connected') {
            setElapsed(0);
            return;
        }
        const interval = setInterval(() => setElapsed(e => e + 1), 1000);
        return () => clearInterval(interval);
    }, [realtimeStatus]);

    if (realtimeStatus !== 'connected' && realtimeStatus !== 'connecting') {
        return null;
    }

    const isActive = realtimeMode === 'listening' || realtimeMode === 'speaking';
    const barMode = realtimeMode === 'speaking' ? 'speaking' as const : 'listening' as const;

    const statusText = realtimeStatus === 'connecting'
        ? 'Connecting...'
        : realtimeMode === 'listening'
            ? 'Listening...'
            : realtimeMode === 'speaking'
                ? 'Agent speaking...'
                : 'Connected';

    // Mode-aware accent color
    const accentColor = realtimeMode === 'speaking'
        ? theme.colors.status.connecting   // blue
        : realtimeMode === 'listening'
            ? theme.colors.status.connected  // green
            : theme.colors.textSecondary;

    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            height: 28,
            paddingHorizontal: 12,
            borderRadius: 6,
            marginHorizontal: 4,
            marginBottom: 4,
            backgroundColor: theme.colors.surfaceHighest,
        }}>
            <VoiceBars
                isActive={isActive}
                mode={barMode}
                color={accentColor}
                size="medium"
            />
            <Text style={{
                flex: 1,
                marginLeft: 8,
                fontSize: 12,
                fontWeight: '500',
                color: accentColor,
                ...Typography.default(),
            }} numberOfLines={1}>
                {statusText}
            </Text>
            {realtimeStatus === 'connected' && (
                <Text style={{
                    fontSize: 12,
                    color: theme.colors.textSecondary,
                    ...Typography.mono(),
                }}>
                    {formatElapsed(elapsed)}
                </Text>
            )}
        </View>
    );
});
