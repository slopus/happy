import * as React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRealtimeStatus, useRealtimeMode, useMicrophoneMuted } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { stopRealtimeSession, toggleMicrophoneMute } from '@/realtime/RealtimeSession';
import { useUnistyles } from 'react-native-unistyles';
import { VoiceBars } from './VoiceBars';

interface VoiceAssistantStatusBarProps {
    variant?: 'full' | 'sidebar';
    style?: any;
}

export const VoiceAssistantStatusBar = React.memo(({ variant = 'full', style }: VoiceAssistantStatusBarProps) => {
    const { theme } = useUnistyles();
    const realtimeStatus = useRealtimeStatus();
    const realtimeMode = useRealtimeMode();
    const microphoneMuted = useMicrophoneMuted();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const collapseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reset expanded state when disconnected
    React.useEffect(() => {
        if (realtimeStatus === 'disconnected') {
            setIsExpanded(false);
            if (collapseTimerRef.current) {
                clearTimeout(collapseTimerRef.current);
                collapseTimerRef.current = null;
            }
        }
    }, [realtimeStatus]);

    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (collapseTimerRef.current) {
                clearTimeout(collapseTimerRef.current);
            }
        };
    }, []);

    // Don't render if disconnected
    if (realtimeStatus === 'disconnected') {
        return null;
    }

    // Check if voice assistant is speaking or thinking
    const isVoiceSpeaking = realtimeMode === 'speaking';
    const isVoiceThinking = realtimeMode === 'thinking';

    const getStatusInfo = () => {
        switch (realtimeStatus) {
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: true,
                    text: 'Connecting...',
                    textColor: theme.colors.text
                };
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: 'Voice Assistant Active',
                    textColor: theme.colors.text
                };
            case 'error':
                return {
                    color: theme.colors.status.error,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: 'Connection Error',
                    textColor: theme.colors.text
                };
            default:
                return {
                    color: theme.colors.status.default,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: 'Voice Assistant',
                    textColor: theme.colors.text
                };
        }
    };

    const statusInfo = getStatusInfo();

    const handlePress = async () => {
        if (realtimeStatus === 'connected' || realtimeStatus === 'connecting' || realtimeStatus === 'error') {
            try {
                await stopRealtimeSession();
            } catch (error) {
                console.error('Error stopping voice session:', error);
            }
        }
    };

    const handleMuteToggle = () => {
        toggleMicrophoneMute();
    };

    const startCollapseTimer = () => {
        if (collapseTimerRef.current) {
            clearTimeout(collapseTimerRef.current);
        }
        collapseTimerRef.current = setTimeout(() => {
            setIsExpanded(false);
            collapseTimerRef.current = null;
        }, 8000);
    };

    const handleFullBarPress = () => {
        // When not connected (connecting/error), tap stops session directly
        if (realtimeStatus !== 'connected') {
            handlePress();
            return;
        }

        if (isExpanded) {
            // Tapping the bar area when expanded collapses it
            setIsExpanded(false);
            if (collapseTimerRef.current) {
                clearTimeout(collapseTimerRef.current);
                collapseTimerRef.current = null;
            }
        } else {
            // Expand and start auto-collapse timer
            setIsExpanded(true);
            startCollapseTimer();
        }
    };

    if (variant === 'full') {
        // Mobile full-width version
        // Shared top row for both collapsed and expanded — keeps layout stable
        const topRow = (
            <View style={styles.content}>
                <View style={styles.leftSection}>
                    <StatusDot
                        color={statusInfo.color}
                        isPulsing={statusInfo.isPulsing}
                        size={8}
                        style={styles.statusDot}
                    />
                    <Ionicons
                        name={microphoneMuted ? 'mic-off' : 'mic'}
                        size={16}
                        color={statusInfo.textColor}
                        style={styles.micIcon}
                    />
                    <Text style={[
                        styles.statusText,
                        { color: statusInfo.textColor }
                    ]}>
                        {statusInfo.text}
                    </Text>
                </View>

                <View style={styles.rightSection}>
                    {(isVoiceSpeaking || isVoiceThinking) && (
                        <VoiceBars
                            isActive
                            color={statusInfo.textColor}
                            size="small"
                            mode={isVoiceThinking ? 'thinking' : 'speaking'}
                        />
                    )}
                    <Text style={[styles.tapToEndText, { color: statusInfo.textColor, marginLeft: (isVoiceSpeaking || isVoiceThinking) ? 8 : 0 }]}>
                        {realtimeStatus === 'connected' ? 'Tap for options' : 'Tap to end'}
                    </Text>
                </View>
            </View>
        );

        return (
            <Pressable
                onPress={handleFullBarPress}
                style={{
                    backgroundColor: statusInfo.backgroundColor,
                    width: '100%',
                    paddingHorizontal: 16,
                }}
            >
                {/* Top row — always 32px, identical in collapsed & expanded */}
                <View style={{ height: 32, justifyContent: 'center' }}>
                    {topRow}
                </View>

                {/* Action buttons — only visible when expanded */}
                {isExpanded && (
                    <View style={styles.expandedActions}>
                        <Pressable
                            onPress={(e) => {
                                e.stopPropagation();
                                handleMuteToggle();
                                startCollapseTimer();
                            }}
                            style={[
                                styles.actionButton,
                                { backgroundColor: microphoneMuted ? theme.colors.text + '1A' : theme.colors.text + '0D' },
                            ]}
                            hitSlop={8}
                        >
                            <Ionicons
                                name={microphoneMuted ? 'mic-off' : 'mic'}
                                size={18}
                                color={statusInfo.textColor}
                            />
                            <Text style={[styles.actionButtonText, { color: statusInfo.textColor }]}>
                                {microphoneMuted ? 'Unmute' : 'Mute'}
                            </Text>
                        </Pressable>

                        <Pressable
                            onPress={(e) => {
                                e.stopPropagation();
                                handlePress();
                            }}
                            style={[
                                styles.actionButton,
                                { backgroundColor: theme.colors.text + '0D' },
                            ]}
                            hitSlop={8}
                        >
                            <Ionicons
                                name="close-circle"
                                size={18}
                                color={theme.colors.status.error}
                            />
                            <Text style={[styles.actionButtonText, { color: theme.colors.status.error }]}>
                                End
                            </Text>
                        </Pressable>
                    </View>
                )}
            </Pressable>
        );
    }

    // Sidebar version
    const containerStyle = [
        styles.container,
        styles.sidebarContainer,
        {
            backgroundColor: statusInfo.backgroundColor,
        },
        style
    ];

    return (
        <View style={containerStyle}>
            <View style={styles.sidebarContent}>
                <View style={styles.leftSection}>
                    <StatusDot
                        color={statusInfo.color}
                        isPulsing={statusInfo.isPulsing}
                        size={8}
                        style={styles.statusDot}
                    />
                    <Ionicons
                        name={microphoneMuted ? 'mic-off' : 'mic'}
                        size={16}
                        color={statusInfo.textColor}
                        style={styles.micIcon}
                    />
                    <Text style={[
                        styles.statusText,
                        styles.sidebarStatusText,
                        { color: statusInfo.textColor }
                    ]}>
                        {statusInfo.text}
                    </Text>
                </View>

                {(isVoiceSpeaking || isVoiceThinking) && (
                    <VoiceBars
                        isActive
                        color={statusInfo.textColor}
                        size="small"
                        mode={isVoiceThinking ? 'thinking' : 'speaking'}
                    />
                )}

                <View style={styles.sidebarButtons}>
                    <Pressable
                        onPress={handleMuteToggle}
                        style={styles.sidebarIconButton}
                        hitSlop={5}
                    >
                        <Ionicons
                            name={microphoneMuted ? 'mic-off' : 'mic'}
                            size={14}
                            color={statusInfo.textColor}
                        />
                    </Pressable>
                    <Pressable
                        onPress={handlePress}
                        style={styles.sidebarIconButton}
                        hitSlop={5}
                    >
                        <Ionicons
                            name="close"
                            size={14}
                            color={statusInfo.textColor}
                        />
                    </Pressable>
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        height: 32,
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        borderRadius: 0,
        marginHorizontal: 0,
        marginVertical: 0,
    },
    fullContainer: {
        justifyContent: 'flex-end',
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
    sidebarContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        paddingHorizontal: 12,
        flex: 1,
    },
    leftSection: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
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
    tapToEndText: {
        fontSize: 12,
        fontWeight: '400',
        opacity: 0.8,
        ...Typography.default(),
    },
    expandedActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 12,
        gap: 8,
    },
    actionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 6,
        borderRadius: 8,
    },
    actionButtonText: {
        fontSize: 13,
        fontWeight: '500',
        ...Typography.default(),
    },
    sidebarButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 4,
        gap: 2,
    },
    sidebarIconButton: {
        padding: 4,
    },
});
