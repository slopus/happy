import * as React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useRealtimeStatus, useRealtimeMode } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { stopRealtimeSession, getCurrentVoiceSessionDurationSeconds } from '@/realtime/RealtimeSession';
import { useUnistyles } from 'react-native-unistyles';
import { VoiceBars } from './VoiceBars';
import { ShimmerView } from './ShimmerView';
import { MobileGlassSurface } from './MobileGlass';
import { MOBILE_GLASS_CONTROL_SIZE, MOBILE_GLASS_CONTROL_RADIUS } from './navigation/headerMetrics';
import { t } from '@/text';

interface VoiceAssistantStatusBarProps {
    variant?: 'full' | 'sidebar';
    style?: any;
}

// Total vertical space the full-variant pill takes below the header —
// layouts that inset content past the header add this while a call runs.
export const VOICE_PILL_TOTAL_HEIGHT = MOBILE_GLASS_CONTROL_SIZE + 6;

function formatCallDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Ticks once a second while mounted so the pill shows a live call duration.
function useCallDuration(active: boolean): string | null {
    const [seconds, setSeconds] = React.useState<number | undefined>(() => getCurrentVoiceSessionDurationSeconds());
    React.useEffect(() => {
        if (!active) {
            return;
        }
        setSeconds(getCurrentVoiceSessionDurationSeconds());
        const interval = setInterval(() => {
            setSeconds(getCurrentVoiceSessionDurationSeconds());
        }, 1000);
        return () => clearInterval(interval);
    }, [active]);
    if (!active || seconds === undefined) {
        return null;
    }
    return formatCallDuration(seconds);
}

export const VoiceAssistantStatusBar = React.memo(({ variant = 'full', style }: VoiceAssistantStatusBarProps) => {
    const { theme } = useUnistyles();
    const realtimeStatus = useRealtimeStatus();
    const realtimeMode = useRealtimeMode();
    const duration = useCallDuration(realtimeStatus === 'connected');

    // Don't render if disconnected
    if (realtimeStatus === 'disconnected') {
        return null;
    }

    // Check if voice assistant or user is speaking (show voice bars for either)
    const isVoiceSpeaking = realtimeMode === 'agent-speaking' || realtimeMode === 'user-speaking';

    const handleEnd = async () => {
        if (realtimeStatus === 'connected' || realtimeStatus === 'connecting' || realtimeStatus === 'error') {
            try {
                await stopRealtimeSession();
            } catch (error) {
                console.error('Error stopping voice session:', error);
            }
        }
    };

    if (variant === 'full') {
        const centerText = realtimeStatus === 'connecting'
            ? t('voiceStatusBar.connecting')
            : realtimeStatus === 'error'
                ? t('voiceStatusBar.error')
                : duration ?? '0:00';
        return (
            <View style={styles.pillWrapper}>
                {/* The whole pill ends the call; "tap to end" is just the hint. */}
                <Pressable onPress={handleEnd} style={({ pressed }) => pressed ? { opacity: 0.7 } : undefined}>
                    <MobileGlassSurface
                        enabled={Platform.OS === 'ios'}
                        nativeEffect
                        material="static"
                        intensity={76}
                        style={[
                            styles.pillGlass,
                            Platform.OS !== 'ios' && { backgroundColor: theme.colors.surfaceHighest },
                            theme.dark
                                ? { borderColor: 'rgba(255, 255, 255, 0.18)' }
                                : { borderColor: '#FFFFFF' },
                        ]}
                    >
                        <View style={styles.pillContent}>
                            <View style={styles.micSlot}>
                                <ShimmerView
                                    shimmerColors={['rgba(255, 255, 255, 0.45)', '#FFFFFF', 'rgba(255, 255, 255, 0.45)']}
                                    duration={1800}
                                >
                                    <Ionicons name="mic" size={24} color="#FFFFFF" />
                                </ShimmerView>
                            </View>

                            <View pointerEvents="none" style={styles.centerOverlay}>
                                <Text style={[styles.durationText, { color: theme.colors.header.tint }]}>
                                    {centerText}
                                </Text>
                            </View>

                            <View style={styles.endControl}>
                                <Text style={[styles.tapToEndText, { color: theme.colors.textSecondary }]}>
                                    {t('voiceStatusBar.tapToEnd')}
                                </Text>
                            </View>
                        </View>
                    </MobileGlassSurface>
                </Pressable>
            </View>
        );
    }

    // Sidebar version
    const sidebarStatus = (() => {
        switch (realtimeStatus) {
            case 'connecting':
                return { color: theme.colors.status.connecting, isPulsing: true, text: t('voiceStatusBar.connecting') };
            case 'error':
                return { color: theme.colors.status.error, isPulsing: false, text: t('voiceStatusBar.error') };
            default:
                return { color: theme.colors.status.connected, isPulsing: false, text: duration ?? t('voiceStatusBar.active') };
        }
    })();

    const containerStyle = [
        styles.container,
        styles.sidebarContainer,
        { backgroundColor: theme.colors.surfaceHighest },
        style,
    ];

    return (
        <View style={containerStyle}>
            <Pressable
                onPress={handleEnd}
                style={styles.pressable}
                hitSlop={5}
            >
                <View style={styles.content}>
                    <View style={styles.leftSection}>
                        <StatusDot
                            color={sidebarStatus.color}
                            isPulsing={sidebarStatus.isPulsing}
                            size={8}
                            style={styles.statusDot}
                        />
                        <Ionicons
                            name="mic"
                            size={16}
                            color={theme.colors.text}
                            style={styles.micIcon}
                        />
                        <Text style={[
                            styles.statusText,
                            styles.sidebarStatusText,
                            { color: theme.colors.text }
                        ]}>
                            {sidebarStatus.text}
                        </Text>
                    </View>

                    {isVoiceSpeaking && (
                        <VoiceBars
                            isActive={isVoiceSpeaking}
                            color={theme.colors.text}
                            size="small"
                        />
                    )}

                    <Ionicons
                        name="close"
                        size={14}
                        color={theme.colors.text}
                        style={[styles.closeIcon, { marginLeft: isVoiceSpeaking ? 4 : 8 }]}
                    />
                </View>
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create({
    // Full-width pill below the header, matching the glass header controls.
    pillWrapper: {
        width: '100%',
        paddingHorizontal: 16,
        paddingTop: 6,
    },
    pillGlass: {
        height: MOBILE_GLASS_CONTROL_SIZE,
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        overflow: 'hidden',
        borderWidth: Platform.select({ ios: 1, default: 0 }),
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
    },
    pillContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    micSlot: {
        width: MOBILE_GLASS_CONTROL_SIZE,
        height: MOBILE_GLASS_CONTROL_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    centerOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    durationText: {
        fontSize: 16,
        lineHeight: 20,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    endControl: {
        height: MOBILE_GLASS_CONTROL_SIZE,
        justifyContent: 'center',
        paddingHorizontal: 16,
    },
    tapToEndText: {
        fontSize: 12,
        fontWeight: '400',
        ...Typography.default(),
    },
    // Sidebar variant
    container: {
        height: 32,
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        borderRadius: 0,
        marginHorizontal: 0,
        marginVertical: 0,
    },
    sidebarContainer: {
    },
    pressable: {
        flex: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        paddingHorizontal: 12,
    },
    leftSection: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    statusDot: {
        marginRight: 6,
    },
    micIcon: {
        marginRight: 6,
    },
    closeIcon: {
        marginLeft: 8,
    },
    statusText: {
        fontSize: 14,
        fontWeight: '500',
        ...Typography.default(),
    },
    sidebarStatusText: {
        fontSize: 12,
    },
});
