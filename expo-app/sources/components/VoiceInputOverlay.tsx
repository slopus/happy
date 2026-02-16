/**
 * VoiceInputOverlay
 *
 * Full-screen overlay shown during voice input recording.
 * Features:
 * - Voice waveform bubble
 * - Bottom sheet with cancel/text zones and release hint
 * - Optional live transcription preview in text zone
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { VoiceInputState } from '@/asr/types';
import { t } from '@/text';

const AUDIO_ACTIVITY_FLOOR = 0.004;
const AUDIO_ACTIVITY_RANGE = 0.02;

interface VoiceInputOverlayProps {
    /** Current voice input state */
    state: VoiceInputState;
    /** Whether the overlay is visible */
    visible: boolean;
}

export const VoiceInputOverlay: React.FC<VoiceInputOverlayProps> = ({
    state,
    visible,
}) => {
    const { theme } = useUnistyles();
    const accentColor = theme.dark ? '#7FE3A9' : '#49D36C';
    const destructiveColor = theme.colors.textDestructive;
    const waveformBubbleColor = theme.dark ? 'rgba(75, 200, 130, 0.6)' : '#9BEA6A';
    const waveformBarColor = theme.dark ? '#E1FFE9' : '#2F6B2F';
    const sheetColor = theme.dark ? 'rgba(40, 40, 44, 0.95)' : 'rgba(210, 210, 210, 0.95)';
    const sheetActionBaseColor = theme.dark ? 'rgba(100, 100, 106, 0.9)' : 'rgba(186, 186, 186, 0.92)';
    const sheetTextBaseColor = theme.dark ? 'rgba(245, 245, 245, 0.9)' : '#FFFFFF';
    const fadeAnim = useRef(new Animated.Value(0)).current;

    // Fade in/out animation
    useEffect(() => {
        Animated.timing(fadeAnim, {
            toValue: visible ? 1 : 0,
            duration: 200,
            useNativeDriver: true,
        }).start();
    }, [visible, fadeAnim]);

    if (!visible && fadeAnim._value === 0) {
        return null;
    }

    const isInCancelZone = state.gestureZone === 'cancel';
    const isInTextZone = state.gestureZone === 'text';

    return (
        <Animated.View
            style={[
                styles.container,
                { opacity: fadeAnim }
            ]}
            pointerEvents="none"
        >
            <BlurView
                intensity={Platform.OS === 'ios' ? 80 : 100}
                tint={theme.dark ? 'dark' : 'light'}
                style={styles.blur}
            >
                {/* Center - Waveform bubble */}
                <View style={styles.center}>
                    <View style={[styles.waveformBubble, { backgroundColor: waveformBubbleColor }]}>
                        <VoiceWaveform
                            isRecording={state.isRecording}
                            isTranscribing={state.isTranscribing}
                            audioLevel={state.audioLevel}
                            accentColor={waveformBarColor}
                        />
                    </View>
                    {isInTextZone && state.transcribedText && (
                        <Text
                            style={[styles.centerTranscript, { color: theme.colors.text }]}
                            numberOfLines={2}
                        >
                            {state.transcribedText}
                        </Text>
                    )}
                    {state.error && (
                        <Text style={[styles.errorText, { color: destructiveColor }]}>
                            {state.error}
                        </Text>
                    )}
                </View>

                {/* Bottom sheet */}
                <View style={[styles.sheet, { backgroundColor: sheetColor }]}>
                    <View style={styles.sheetRow}>
                        {/* Cancel */}
                        <View style={[
                            styles.sheetAction,
                            { backgroundColor: sheetActionBaseColor },
                            isInCancelZone && {
                                backgroundColor: destructiveColor,
                                borderColor: destructiveColor,
                            }
                        ]}>
                            <Text style={[
                                styles.sheetActionText,
                                { color: isInCancelZone ? '#FFFFFF' : sheetTextBaseColor }
                            ]}>
                                {t('voiceInput.cancel') || '取消'}
                            </Text>
                        </View>

                        {/* Text */}
                        <View style={[
                            styles.sheetAction,
                            { backgroundColor: sheetActionBaseColor },
                            isInTextZone && {
                                backgroundColor: accentColor,
                                borderColor: accentColor,
                            }
                        ]}>
                            <Text style={[
                                styles.sheetActionText,
                                { color: isInTextZone ? '#FFFFFF' : sheetTextBaseColor }
                            ]}>
                                {t('voiceInput.slideToText') || '滑到这里 转文字'}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.releaseBubble}>
                        <Text style={[styles.releaseBubbleText, { color: theme.colors.text }]}>
                            {t('voiceInput.releaseToSend') || '松开 发送'}
                        </Text>
                    </View>
                </View>
            </BlurView>
        </Animated.View>
    );
};

/**
 * Voice waveform animation component
 */
const VoiceWaveform: React.FC<{
    isRecording: boolean;
    isTranscribing: boolean;
    audioLevel: number;
    accentColor: string;
}> = ({ isRecording, isTranscribing, audioLevel, accentColor }) => {
    const { theme } = useUnistyles();
    const barCount = 7;
    const barHeight = 20;
    const baseScale = 0.4;
    const lastContainerLogRef = useRef<number>(0);
    const lastBarLogRef = useRef<number>(0);
    const lastMetricsLogRef = useRef<number>(0);
    const containerLayoutRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
    const barLayoutRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
    const bar0ScaleRef = useRef(baseScale);
    const activityValueRef = useRef(0);
    const minActivityRef = useRef(0);
    const silenceMsRef = useRef(0);
    const silenceSinceRef = useRef<number | null>(null);
    const activityAnim = useRef(new Animated.Value(0)).current;
    const animations = useRef(
        Array.from({ length: barCount }, () => new Animated.Value(baseScale))
    ).current;
    const isActive = isRecording;

    const logLayout = React.useCallback((label: 'container' | 'bar0', layout: { x: number; y: number; width: number; height: number }) => {
        const now = Date.now();
        const lastLogRef = label === 'container' ? lastContainerLogRef : lastBarLogRef;
        if (now - lastLogRef.current < 800) {
            return;
        }
        lastLogRef.current = now;
        console.log('[voice-input][ui] waveform layout', {
            label,
            x: Math.round(layout.x),
            y: Math.round(layout.y),
            width: Math.round(layout.width),
            height: Math.round(layout.height),
            baseScale,
            barHeight,
            isActive,
            audioLevel: Number(audioLevel.toFixed(4)),
        });
    }, [audioLevel, barHeight, baseScale, isActive]);

    const logWaveformMetrics = React.useCallback((label: string) => {
        const now = Date.now();
        if (now - lastMetricsLogRef.current < 800) {
            return;
        }
        const containerLayout = containerLayoutRef.current;
        const barLayout = barLayoutRef.current;
        if (!containerLayout || !barLayout) {
            return;
        }
        lastMetricsLogRef.current = now;
        const activity = activityValueRef.current;
        const minActivity = minActivityRef.current;
        const silenceMs = silenceMsRef.current;
        const scale = baseScale + activity * (bar0ScaleRef.current - baseScale);
        const visualTop = barLayout.y + barLayout.height / 2 - (barLayout.height * scale) / 2;
        const visualBottom = visualTop + barLayout.height * scale;
        console.log('[voice-input][ui] waveform pixels', {
            label,
            containerX: Math.round(containerLayout.x),
            containerY: Math.round(containerLayout.y),
            containerWidth: Math.round(containerLayout.width),
            containerHeight: Math.round(containerLayout.height),
            barX: Math.round(barLayout.x),
            barY: Math.round(barLayout.y),
            barWidth: Math.round(barLayout.width),
            barHeight: Math.round(barLayout.height),
            scale: Number(scale.toFixed(3)),
            activity: Number(activity.toFixed(3)),
            minActivity: Number(minActivity.toFixed(3)),
            silenceMs: Math.round(silenceMs),
            visualTop: Math.round(visualTop),
            visualBottom: Math.round(visualBottom),
            isActive,
            audioLevel: Number(audioLevel.toFixed(4)),
        });
    }, [audioLevel, isActive, baseScale]);

    useEffect(() => {
        const id = animations[0].addListener(({ value }) => {
            bar0ScaleRef.current = value;
        });
        return () => {
            animations[0].removeListener(id);
        };
    }, [animations]);

    useEffect(() => {
        const id = activityAnim.addListener(({ value }) => {
            activityValueRef.current = value;
        });
        return () => {
            activityAnim.removeListener(id);
        };
    }, [activityAnim]);

    useEffect(() => {
        if (!isRecording) {
            // Keep a visible static waveform when silent
            animations.forEach(anim => anim.setValue(baseScale));
            animations.forEach(anim => anim.stopAnimation());
            return;
        }

        // Animate each bar with different timing
        const animateBar = (index: number) => {
            const randomDuration = 200 + Math.random() * 300;
            const randomDelay = index * 50;
            const peakValue = baseScale + Math.random() * (1 - baseScale);

            Animated.loop(
                Animated.sequence([
                    Animated.delay(randomDelay),
                    Animated.timing(animations[index], {
                        toValue: peakValue,
                        duration: randomDuration,
                        useNativeDriver: true,
                    }),
                    Animated.timing(animations[index], {
                        toValue: baseScale,
                        duration: randomDuration,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        };

        animations.forEach((_, index) => animateBar(index));

        return () => {
            animations.forEach(anim => anim.stopAnimation());
        };
    }, [isRecording, animations, baseScale]);

    useEffect(() => {
        if (!isRecording) {
            activityAnim.setValue(0);
            minActivityRef.current = 0;
            silenceMsRef.current = 0;
            silenceSinceRef.current = null;
            return;
        }
        const now = Date.now();
        if (audioLevel <= AUDIO_ACTIVITY_FLOOR) {
            if (silenceSinceRef.current === null) {
                silenceSinceRef.current = now;
            }
        } else {
            silenceSinceRef.current = null;
        }
        const silenceMs = silenceSinceRef.current ? now - silenceSinceRef.current : 0;
        const minActivity = silenceMs > 700 ? 0 : 0.15;
        const normalized = Math.max(0, audioLevel - AUDIO_ACTIVITY_FLOOR);
        const target = Math.min(1, normalized / AUDIO_ACTIVITY_RANGE);
        const finalTarget = Math.min(1, Math.max(minActivity, target));
        minActivityRef.current = minActivity;
        silenceMsRef.current = silenceMs;
        Animated.timing(activityAnim, {
            toValue: finalTarget,
            duration: silenceMs > 700 ? 220 : 160,
            useNativeDriver: true,
        }).start();
    }, [activityAnim, audioLevel, isRecording]);

    useEffect(() => {
        if (!isRecording) {
            return;
        }
        logWaveformMetrics('tick');
    }, [audioLevel, isRecording, logWaveformMetrics]);

    return (
        <View
            style={styles.waveformContainer}
            onLayout={(event) => {
                if (isRecording) {
                    const layout = event.nativeEvent.layout;
                    containerLayoutRef.current = layout;
                    logLayout('container', layout);
                }
            }}
        >
            {animations.map((anim, index) => (
                <Animated.View
                    key={index}
                    onLayout={(event) => {
                        if (index === 0 && isRecording) {
                            const layout = event.nativeEvent.layout;
                            barLayoutRef.current = layout;
                            logLayout('bar0', layout);
                            logWaveformMetrics('layout');
                        }
                    }}
                    style={[
                        styles.waveformBar,
                        {
                            // Blend between static base scale and active animation to avoid a jump on first sound.
                            backgroundColor: isTranscribing
                                ? theme.colors.textSecondary
                                : accentColor,
                            opacity: isActive ? 1 : 0.9,
                            height: barHeight,
                            transform: [
                                {
                                    scaleY: Animated.add(
                                        Animated.multiply(
                                            activityAnim,
                                            Animated.subtract(anim, baseScale)
                                        ),
                                        baseScale
                                    ),
                                },
                            ],
                        }
                    ]}
                />
            ))}
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
    },
    blur: {
        flex: 1,
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(0, 0, 0, 0.18)',
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 240,
    },
    waveformContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        height: 32,
        gap: 4,
    },
    waveformBar: {
        width: 4,
        height: 24,
        borderRadius: 2,
    },
    waveformBubble: {
        minWidth: 200,
        minHeight: 70,
        paddingHorizontal: 32,
        paddingVertical: 18,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: Math.min(0.22, theme.colors.shadow.opacity + 0.12),
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
        elevation: 8,
    },
    errorText: {
        marginTop: 10,
        fontSize: 13,
        ...Typography.default(),
    },
    centerTranscript: {
        marginTop: 12,
        fontSize: 14,
        ...Typography.default(),
        textAlign: 'center',
        maxWidth: 260,
    },
    sheet: {
        paddingTop: 16,
        paddingHorizontal: 20,
        paddingBottom: 100,
        borderTopLeftRadius: 80,
        borderTopRightRadius: 80,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: Math.min(0.25, theme.colors.shadow.opacity + 0.15),
        shadowRadius: 24,
        shadowOffset: { width: 0, height: -8 },
        elevation: 12,
    },
    sheetRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
    },
    sheetAction: {
        flex: 1,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sheetActionText: {
        fontSize: 14,
        ...Typography.default('semiBold'),
        textAlign: 'center',
    },
    releaseBubble: {
        alignSelf: 'center',
        marginTop: 24,
        paddingHorizontal: 24,
        justifyContent: 'center',
    },
    releaseBubbleText: {
        fontSize: 15,
        ...Typography.default('medium'),
        textAlign: 'center',
    },
}));
