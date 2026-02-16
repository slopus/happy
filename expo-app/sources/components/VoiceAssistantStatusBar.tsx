import * as React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRealtimeStatus, useRealtimeMode, useRealtimeMuted } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { stopRealtimeSession, toggleRealtimeMuted } from '@/realtime/RealtimeSession';
import { useUnistyles } from 'react-native-unistyles';
import { VoiceBars } from './VoiceBars';
import { t } from '@/text';

interface VoiceAssistantStatusBarProps {
    variant?: 'full' | 'sidebar';
    style?: any;
}

export const VoiceAssistantStatusBar = React.memo(({ variant = 'full', style }: VoiceAssistantStatusBarProps) => {
    const { theme } = useUnistyles();
    const realtimeStatus = useRealtimeStatus();
    const realtimeMode = useRealtimeMode();
    const realtimeMuted = useRealtimeMuted();

    // Don't render if disconnected
    if (realtimeStatus === 'disconnected') {
        return null;
    }

    // Check if voice assistant is speaking
    const isVoiceSpeaking = realtimeMode === 'speaking';

    const getStatusInfo = () => {
        if (realtimeMuted) {
            return {
                color: '#FF9500',
                backgroundColor: theme.colors.surfaceHighest,
                isPulsing: false,
                text: t('settingsVoice.panel.muted'),
                textColor: theme.colors.text
            };
        }
        switch (realtimeStatus) {
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: true,
                    text: t('settingsVoice.panel.connecting'),
                    textColor: theme.colors.text
                };
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    backgroundColor: theme.colors.surfaceHighest,
                    isPulsing: false,
                    text: isVoiceSpeaking ? t('settingsVoice.panel.speaking') : t('settingsVoice.panel.listening'),
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
                    text: t('settingsVoice.panel.voiceAssistant'),
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

    const handleMutePress = (e: any) => {
        e.stopPropagation();
        toggleRealtimeMuted();
    };

    if (variant === 'full') {
        // Mobile full-width version
        return (
            <View style={{
                backgroundColor: statusInfo.backgroundColor,
                height: 40,
                width: '100%',
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 12,
            }}>
                <View style={styles.content}>
                    {/* Mute Button */}
                    <Pressable
                        onPress={handleMutePress}
                        style={[
                            styles.muteButton,
                            {
                                backgroundColor: realtimeMuted ? '#FF9500' : 'transparent',
                                borderColor: realtimeMuted ? '#FF9500' : theme.colors.divider,
                            }
                        ]}
                        hitSlop={5}
                    >
                        <Ionicons
                            name={realtimeMuted ? 'mic-off' : 'mic'}
                            size={16}
                            color={realtimeMuted ? '#FFFFFF' : statusInfo.textColor}
                        />
                    </Pressable>

                    {/* Status Section */}
                    <Pressable
                        onPress={handlePress}
                        style={styles.statusSection}
                        hitSlop={10}
                    >
                        <View style={styles.leftSection}>
                            <StatusDot
                                color={statusInfo.color}
                                isPulsing={statusInfo.isPulsing}
                                size={8}
                                style={styles.statusDot}
                            />
                            <Text style={[
                                styles.statusText,
                                { color: statusInfo.textColor }
                            ]}>
                                {statusInfo.text}
                            </Text>
                        </View>

                        <View style={styles.rightSection}>
                            {isVoiceSpeaking && (
                                <VoiceBars
                                    isActive={isVoiceSpeaking}
                                    color={statusInfo.textColor}
                                    size="small"
                                />
                            )}
                            <Text style={[styles.tapToEndText, { color: statusInfo.textColor, marginLeft: isVoiceSpeaking ? 8 : 0 }]}>
                                {t('settingsVoice.panel.end')}
                            </Text>
                        </View>
                    </Pressable>
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
            <View style={[styles.content, { paddingHorizontal: 8 }]}>
                {/* Mute Button */}
                <Pressable
                    onPress={handleMutePress}
                    style={[
                        styles.muteButton,
                        {
                            width: 24,
                            height: 24,
                            backgroundColor: realtimeMuted ? '#FF9500' : 'transparent',
                            borderColor: realtimeMuted ? '#FF9500' : theme.colors.divider,
                        }
                    ]}
                    hitSlop={5}
                >
                    <Ionicons
                        name={realtimeMuted ? 'mic-off' : 'mic'}
                        size={12}
                        color={realtimeMuted ? '#FFFFFF' : statusInfo.textColor}
                    />
                </Pressable>

                {/* Status Section */}
                <Pressable
                    onPress={handlePress}
                    style={[styles.statusSection, { flex: 1 }]}
                    hitSlop={5}
                >
                    <View style={styles.leftSection}>
                        <StatusDot
                            color={statusInfo.color}
                            isPulsing={statusInfo.isPulsing}
                            size={8}
                            style={styles.statusDot}
                        />
                        <Text style={[
                            styles.statusText,
                            styles.sidebarStatusText,
                            { color: statusInfo.textColor }
                        ]} numberOfLines={1}>
                            {statusInfo.text}
                        </Text>
                    </View>

                    {isVoiceSpeaking && (
                        <VoiceBars
                            isActive={isVoiceSpeaking}
                            color={statusInfo.textColor}
                            size="small"
                        />
                    )}

                    <Ionicons
                        name="close"
                        size={14}
                        color={statusInfo.textColor}
                        style={[styles.closeIcon, { marginLeft: isVoiceSpeaking ? 4 : 8 }]}
                    />
                </Pressable>
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
        paddingHorizontal: 0,
    },
    muteButton: {
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        marginRight: 8,
    },
    statusSection: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '100%',
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
});