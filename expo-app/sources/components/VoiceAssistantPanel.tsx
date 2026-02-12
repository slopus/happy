import * as React from 'react';
import { memo, useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRealtimeStatus, useRealtimeMode, useVoiceTranscript } from '@/sync/storage';
import { stopRealtimeSession } from '@/realtime/RealtimeSession';
import { Typography } from '@/constants/Typography';
import { VoiceBars } from './VoiceBars';
import { t } from '@/text';

const PANEL_HEIGHT = 200;

/**
 * VoiceAssistantPanel - A floating bottom panel for voice interaction
 * Features:
 * - Slide-up animation when voice is active
 * - Real-time waveform visualization
 * - Live transcription display
 * - Status indicators (connecting/listening/speaking)
 * - Large stop button
 */
export const VoiceAssistantPanel = memo(function VoiceAssistantPanel() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const realtimeStatus = useRealtimeStatus();
    const realtimeMode = useRealtimeMode();
    const { text: transcript, role: transcriptRole } = useVoiceTranscript();

    // Animation values
    const slideAnim = useRef(new Animated.Value(PANEL_HEIGHT + insets.bottom)).current;
    const opacityAnim = useRef(new Animated.Value(0)).current;

    // Pulse animation for listening indicator
    const pulseAnim = useRef(new Animated.Value(1)).current;

    const isVisible = realtimeStatus !== 'disconnected';
    const isConnecting = realtimeStatus === 'connecting';
    const isConnected = realtimeStatus === 'connected';
    const isSpeaking = realtimeMode === 'speaking';
    const isListening = isConnected && !isSpeaking;

    // Slide in/out animation
    useEffect(() => {
        if (isVisible) {
            Animated.parallel([
                Animated.spring(slideAnim, {
                    toValue: 0,
                    useNativeDriver: true,
                    tension: 65,
                    friction: 11,
                }),
                Animated.timing(opacityAnim, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: true,
                }),
            ]).start();
        } else {
            Animated.parallel([
                Animated.timing(slideAnim, {
                    toValue: PANEL_HEIGHT + insets.bottom,
                    duration: 250,
                    useNativeDriver: true,
                }),
                Animated.timing(opacityAnim, {
                    toValue: 0,
                    duration: 200,
                    useNativeDriver: true,
                }),
            ]).start();
        }
    }, [isVisible, insets.bottom]);

    // Pulse animation for listening state
    useEffect(() => {
        if (isListening) {
            const pulse = Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 1.15,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            );
            pulse.start();
            return () => pulse.stop();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isListening]);

    const handleStop = async () => {
        try {
            await stopRealtimeSession();
        } catch (error) {
            console.error('Error stopping voice session:', error);
        }
    };

    const getStatusText = () => {
        if (isConnecting) return t('settingsVoice.panel.connecting');
        if (isSpeaking) return t('settingsVoice.panel.speaking');
        if (isListening) return t('settingsVoice.panel.listening');
        return t('settingsVoice.panel.voiceAssistant');
    };

    const getStatusColor = () => {
        if (isConnecting) return theme.colors.status.connecting;
        if (isSpeaking) return '#34C759'; // Green for speaking
        if (isListening) return '#007AFF'; // Blue for listening
        return theme.colors.textSecondary;
    };

    if (!isVisible) {
        return null;
    }

    return (
        <Animated.View
            style={[
                styles.container,
                {
                    paddingBottom: insets.bottom + 16,
                    transform: [{ translateY: slideAnim }],
                    opacity: opacityAnim,
                }
            ]}
            pointerEvents="box-none"
        >
            <BlurView
                intensity={80}
                tint={theme.colors.background === '#000000' ? 'dark' : 'light'}
                style={styles.blurContainer}
            >
                <View style={[styles.content, { backgroundColor: theme.colors.surface + 'E6' }]}>
                    {/* Status Section */}
                    <View style={styles.statusSection}>
                        {/* Status Indicator */}
                        <Animated.View
                            style={[
                                styles.statusIndicator,
                                {
                                    backgroundColor: getStatusColor(),
                                    transform: [{ scale: pulseAnim }],
                                }
                            ]}
                        />
                        <Text style={[styles.statusText, { color: theme.colors.text }]}>
                            {getStatusText()}
                        </Text>

                        {/* Voice Bars when speaking */}
                        {isSpeaking && (
                            <View style={styles.voiceBarsContainer}>
                                <VoiceBars isActive={true} color={getStatusColor()} size="medium" />
                            </View>
                        )}
                    </View>

                    {/* Waveform Visualization */}
                    <View style={styles.waveformSection}>
                        <WaveformVisualization
                            isListening={isListening}
                            isSpeaking={isSpeaking}
                            color={getStatusColor()}
                        />
                    </View>

                    {/* Transcript Section */}
                    <View style={styles.transcriptSection}>
                        {transcript ? (
                            <View style={styles.transcriptContainer}>
                                <Text
                                    style={[
                                        styles.transcriptLabel,
                                        { color: theme.colors.textSecondary }
                                    ]}
                                >
                                    {transcriptRole === 'user' ? t('settingsVoice.panel.you') : t('settingsVoice.panel.assistant')}
                                </Text>
                                <Text
                                    style={[
                                        styles.transcriptText,
                                        { color: theme.colors.text }
                                    ]}
                                    numberOfLines={2}
                                >
                                    {transcript}
                                </Text>
                            </View>
                        ) : (
                            <Text style={[styles.placeholderText, { color: theme.colors.textSecondary }]}>
                                {isListening ? t('settingsVoice.panel.startSpeaking') : t('settingsVoice.panel.waiting')}
                            </Text>
                        )}
                    </View>

                    {/* Stop Button */}
                    <Pressable
                        style={({ pressed }) => [
                            styles.stopButton,
                            {
                                backgroundColor: '#FF3B30',
                                opacity: pressed ? 0.8 : 1,
                            }
                        ]}
                        onPress={handleStop}
                    >
                        <Ionicons name="stop" size={24} color="#FFFFFF" />
                        <Text style={styles.stopButtonText}>{t('settingsVoice.panel.end')}</Text>
                    </Pressable>
                </View>
            </BlurView>
        </Animated.View>
    );
});

/**
 * Animated waveform visualization
 */
const WaveformVisualization = memo(function WaveformVisualization({
    isListening,
    isSpeaking,
    color,
}: {
    isListening: boolean;
    isSpeaking: boolean;
    color: string;
}) {
    const bars = useRef(
        Array.from({ length: 20 }, () => new Animated.Value(0.2))
    ).current;

    useEffect(() => {
        if (isListening || isSpeaking) {
            // Animate bars with random heights
            const animations = bars.map((bar, index) => {
                const duration = 200 + Math.random() * 300;
                const delay = index * 30;

                return Animated.loop(
                    Animated.sequence([
                        Animated.delay(delay),
                        Animated.timing(bar, {
                            toValue: 0.3 + Math.random() * 0.7,
                            duration,
                            useNativeDriver: true,
                        }),
                        Animated.timing(bar, {
                            toValue: 0.2 + Math.random() * 0.3,
                            duration,
                            useNativeDriver: true,
                        }),
                    ])
                );
            });

            const composite = Animated.parallel(animations);
            composite.start();

            return () => {
                composite.stop();
                bars.forEach(bar => bar.setValue(0.2));
            };
        } else {
            // Reset to idle state
            Animated.parallel(
                bars.map(bar =>
                    Animated.timing(bar, {
                        toValue: 0.15,
                        duration: 300,
                        useNativeDriver: true,
                    })
                )
            ).start();
        }
    }, [isListening, isSpeaking]);

    return (
        <View style={waveformStyles.container}>
            {bars.map((bar, index) => (
                <Animated.View
                    key={index}
                    style={[
                        waveformStyles.bar,
                        {
                            backgroundColor: color,
                            transform: [{ scaleY: bar }],
                        }
                    ]}
                />
            ))}
        </View>
    );
});

const waveformStyles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        height: 40,
        gap: 3,
    },
    bar: {
        width: 4,
        height: 40,
        borderRadius: 2,
    },
});

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
    },
    blurContainer: {
        overflow: 'hidden',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
    },
    content: {
        paddingTop: 20,
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
    },
    statusSection: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    statusIndicator: {
        width: 10,
        height: 10,
        borderRadius: 5,
        marginRight: 8,
    },
    statusText: {
        fontSize: 16,
        fontWeight: '600',
        ...Typography.default(),
    },
    voiceBarsContainer: {
        marginLeft: 12,
    },
    waveformSection: {
        height: 50,
        justifyContent: 'center',
        marginBottom: 12,
    },
    transcriptSection: {
        minHeight: 50,
        justifyContent: 'center',
        marginBottom: 16,
    },
    transcriptContainer: {
        gap: 4,
    },
    transcriptLabel: {
        fontSize: 12,
        fontWeight: '500',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        ...Typography.default(),
    },
    transcriptText: {
        fontSize: 16,
        lineHeight: 22,
        ...Typography.default(),
    },
    placeholderText: {
        fontSize: 15,
        fontStyle: 'italic',
        ...Typography.default(),
    },
    stopButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 14,
        borderRadius: 14,
        gap: 8,
    },
    stopButtonText: {
        color: '#FFFFFF',
        fontSize: 17,
        fontWeight: '600',
        ...Typography.default(),
    },
}));
