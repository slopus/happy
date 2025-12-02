import * as React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRealtimeStatus, useRealtimeMicMuted, storage } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { stopRealtimeSession } from '@/realtime/RealtimeSession';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface VoiceAssistantStatusBarProps {
    variant?: 'full' | 'sidebar';
    style?: any;
}

export const VoiceAssistantStatusBar = React.memo(({ variant = 'full', style }: VoiceAssistantStatusBarProps) => {
    const { theme } = useUnistyles();
    const realtimeStatus = useRealtimeStatus();
    const micMuted = useRealtimeMicMuted();

    // Don't render if disconnected
    if (realtimeStatus === 'disconnected') {
        return null;
    }

    const handleMuteToggle = () => {
        storage.getState().toggleRealtimeMicMuted();
    };

    const getStatusInfo = () => {
        switch (realtimeStatus) {
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: true,
                    text: t('voiceAssistant.status.connecting'),
                    textColor: theme.colors.text
                };
            case 'connected':
                return {
                    color: micMuted ? theme.colors.status.default : theme.colors.status.connected,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: micMuted ? t('voiceAssistant.status.muted') : t('voiceAssistant.status.active'),
                    textColor: theme.colors.text
                };
            case 'error':
                return {
                    color: theme.colors.status.error,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: t('voiceAssistant.status.error'),
                    textColor: theme.colors.text
                };
            default:
                return {
                    color: theme.colors.status.default,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: t('voiceAssistant.status.default'),
                    textColor: theme.colors.text
                };
        }
    };

    const statusInfo = getStatusInfo();

    const handlePress = async () => {
        if (realtimeStatus === 'connected' || realtimeStatus === 'connecting') {
            try {
                await stopRealtimeSession();
            } catch (error) {
                console.error('Error stopping voice session:', error);
            }
        }
    };

    if (variant === 'full') {
        // Mobile full-width version
        return (
            <View style={{
                backgroundColor: statusInfo.backgroundColor,
                height: 32,
                width: '100%',
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 16,
            }}>
                <View style={styles.content}>
                    {/* Left section - status info (tappable to end) */}
                    <Pressable
                        onPress={handlePress}
                        style={styles.leftSection}
                        hitSlop={10}
                    >
                        <StatusDot
                            color={statusInfo.color}
                            isPulsing={statusInfo.isPulsing}
                            size={8}
                            style={styles.statusDot}
                        />
                        <Ionicons
                            name={micMuted ? "mic-off" : "mic"}
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
                    </Pressable>

                    {/* Right section - mute button and end button */}
                    <View style={styles.rightSection}>
                        {/* Mute button - only show when connected */}
                        {realtimeStatus === 'connected' && (
                            <Pressable
                                onPress={handleMuteToggle}
                                style={({ pressed }) => [
                                    styles.muteButton,
                                    pressed && styles.buttonPressed
                                ]}
                                hitSlop={10}
                            >
                                <Ionicons
                                    name={micMuted ? "mic-off" : "mic"}
                                    size={14}
                                    color={statusInfo.textColor}
                                />
                                <Text style={[styles.buttonText, { color: statusInfo.textColor }]}>
                                    {micMuted ? t('voiceAssistant.unmute') : t('voiceAssistant.mute')}
                                </Text>
                            </Pressable>
                        )}
                        {/* End button */}
                        <Pressable
                            onPress={handlePress}
                            style={({ pressed }) => [
                                styles.endButton,
                                pressed && styles.buttonPressed
                            ]}
                            hitSlop={10}
                        >
                            <Text style={[styles.buttonText, { color: statusInfo.textColor }]}>
                                {t('voiceAssistant.end')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
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
            <View style={styles.content}>
                {/* Left section - status info */}
                <View style={styles.leftSection}>
                    <StatusDot
                        color={statusInfo.color}
                        isPulsing={statusInfo.isPulsing}
                        size={8}
                        style={styles.statusDot}
                    />
                    <Ionicons
                        name={micMuted ? "mic-off" : "mic"}
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

                {/* Right section - mute and close buttons */}
                <View style={styles.sidebarButtons}>
                    {/* Mute button - only show when connected */}
                    {realtimeStatus === 'connected' && (
                        <Pressable
                            onPress={handleMuteToggle}
                            hitSlop={5}
                            style={({ pressed }) => pressed && styles.buttonPressed}
                        >
                            <Ionicons
                                name={micMuted ? "mic-off" : "mic"}
                                size={14}
                                color={statusInfo.textColor}
                            />
                        </Pressable>
                    )}
                    {/* Close button */}
                    <Pressable
                        onPress={handlePress}
                        hitSlop={5}
                        style={({ pressed }) => pressed && styles.buttonPressed}
                    >
                        <Ionicons
                            name="close"
                            size={14}
                            color={statusInfo.textColor}
                            style={styles.closeIcon}
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
    leftSection: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    sidebarButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    muteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    endButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonText: {
        fontSize: 12,
        fontWeight: '500',
        ...Typography.default(),
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
});