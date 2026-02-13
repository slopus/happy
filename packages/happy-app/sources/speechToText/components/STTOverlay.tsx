/**
 * STT Overlay
 *
 * Full-screen overlay for speech-to-text recording (Feishu-style).
 * Features:
 * - Audio waveform visualization
 * - Real-time transcript display
 * - Cancel/Confirm buttons
 * - Slide up to cancel gesture
 */

import * as React from 'react';
import {
    View,
    Text,
    Pressable,
    Modal,
    Dimensions,
    Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
    runOnJS,
    FadeIn,
    FadeOut,
    SlideInDown,
    SlideOutDown,
} from 'react-native-reanimated';
import {
    Gesture,
    GestureDetector,
    GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight, hapticsSuccess, hapticsError } from '@/components/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STTWaveform } from './STTWaveform';
import { STTTranscriptView } from './STTTranscriptView';
import { t } from '@/text';

// =============================================================================
// Types
// =============================================================================

export interface STTOverlayProps {
    /** Whether the overlay is visible */
    visible: boolean;
    /** Current transcript text */
    transcript: string;
    /** Current audio level (0-1) */
    audioLevel: number;
    /** Whether processing final result */
    isProcessing?: boolean;
    /** Cancel callback */
    onCancel: () => void;
    /** Confirm callback */
    onConfirm: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const CANCEL_THRESHOLD = -100; // Slide up distance to trigger cancel
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// =============================================================================
// Styles
// =============================================================================

const stylesheet = StyleSheet.create((theme, runtime) => ({
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        justifyContent: 'flex-end',
    },
    container: {
        backgroundColor: theme.colors.background,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        paddingTop: 12,
        paddingBottom: Platform.OS === 'ios' ? 34 : 24,
        minHeight: 320,
        maxHeight: SCREEN_HEIGHT * 0.6,
    },
    handle: {
        width: 36,
        height: 4,
        backgroundColor: theme.colors.divider,
        borderRadius: 2,
        alignSelf: 'center',
        marginBottom: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        marginBottom: 8,
    },
    recordingIndicator: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.error,
        marginRight: 8,
    },
    headerText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    waveformContainer: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    transcriptContainer: {
        flex: 1,
        marginHorizontal: 16,
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        marginBottom: 16,
    },
    actionsContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
        gap: 48,
    },
    actionButton: {
        width: 64,
        height: 64,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cancelButton: {
        backgroundColor: theme.colors.surfacePressed,
    },
    confirmButton: {
        backgroundColor: theme.colors.tint,
    },
    actionLabel: {
        marginTop: 8,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    cancelHint: {
        textAlign: 'center',
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 16,
        ...Typography.default(),
    },
    cancelZone: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 60,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cancelZoneActive: {
        backgroundColor: 'rgba(255, 59, 48, 0.2)',
    },
    cancelZoneText: {
        fontSize: 14,
        color: theme.colors.error,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
}));

// =============================================================================
// Recording Indicator Component
// =============================================================================

const RecordingIndicator = React.memo(() => {
    const styles = stylesheet;

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: withTiming(1, { duration: 500 }),
            transform: [
                {
                    scale: withSpring(1.2, {
                        damping: 10,
                        stiffness: 100,
                    }),
                },
            ],
        };
    }, []);

    return <Animated.View style={[styles.recordingIndicator, animatedStyle]} />;
});

RecordingIndicator.displayName = 'RecordingIndicator';

// =============================================================================
// Main Component
// =============================================================================

export const STTOverlay = React.memo<STTOverlayProps>(({
    visible,
    transcript,
    audioLevel,
    isProcessing = false,
    onCancel,
    onConfirm,
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();

    // Gesture state
    const translateY = useSharedValue(0);
    const isInCancelZone = useSharedValue(false);

    // Handle cancel action
    const handleCancel = React.useCallback(() => {
        hapticsError();
        onCancel();
    }, [onCancel]);

    // Handle confirm action
    const handleConfirm = React.useCallback(() => {
        hapticsSuccess();
        onConfirm();
    }, [onConfirm]);

    // Pan gesture for slide-to-cancel
    const panGesture = Gesture.Pan()
        .onUpdate((event) => {
            // Only allow upward drag
            if (event.translationY < 0) {
                translateY.value = event.translationY;
                isInCancelZone.value = event.translationY < CANCEL_THRESHOLD;
            }
        })
        .onEnd((event) => {
            if (event.translationY < CANCEL_THRESHOLD) {
                // Trigger cancel
                runOnJS(handleCancel)();
            } else {
                // Spring back
                translateY.value = withSpring(0);
            }
            isInCancelZone.value = false;
        });

    // Animated container style
    const containerAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: Math.min(0, translateY.value) }],
        };
    });

    // Animated cancel zone style
    const cancelZoneAnimatedStyle = useAnimatedStyle(() => {
        return {
            opacity: withTiming(isInCancelZone.value ? 1 : 0, { duration: 150 }),
        };
    });

    if (!visible) return null;

    return (
        <Modal
            visible={visible}
            transparent
            animationType="none"
            statusBarTranslucent
            onRequestClose={handleCancel}
        >
            <GestureHandlerRootView style={{ flex: 1 }}>
                <Animated.View
                    style={styles.modalOverlay}
                    entering={FadeIn.duration(200)}
                    exiting={FadeOut.duration(200)}
                >
                    {/* Cancel zone indicator */}
                    <Animated.View
                        style={[
                            styles.cancelZone,
                            styles.cancelZoneActive,
                            cancelZoneAnimatedStyle,
                        ]}
                    >
                        <Text style={styles.cancelZoneText}>
                            {t('stt.releaseToCancel') || 'Release to cancel'}
                        </Text>
                    </Animated.View>

                    <GestureDetector gesture={panGesture}>
                        <Animated.View
                            style={[
                                styles.container,
                                { paddingBottom: insets.bottom + 16 },
                                containerAnimatedStyle,
                            ]}
                            entering={SlideInDown.springify().damping(20)}
                            exiting={SlideOutDown.duration(200)}
                        >
                            {/* Drag handle */}
                            <View style={styles.handle} />

                            {/* Header */}
                            <View style={styles.header}>
                                {!isProcessing && <RecordingIndicator />}
                                <Text style={styles.headerText}>
                                    {isProcessing
                                        ? (t('stt.processing') || 'Processing...')
                                        : (t('stt.recording') || 'Listening...')}
                                </Text>
                            </View>

                            {/* Waveform */}
                            <View style={styles.waveformContainer}>
                                <STTWaveform
                                    level={audioLevel}
                                    isRecording={!isProcessing}
                                    barCount={7}
                                />
                            </View>

                            {/* Transcript */}
                            <View style={styles.transcriptContainer}>
                                <STTTranscriptView
                                    transcript={transcript}
                                    isProcessing={isProcessing}
                                    placeholder={t('stt.speakNow') || 'Start speaking...'}
                                />
                            </View>

                            {/* Action buttons */}
                            <View style={styles.actionsContainer}>
                                {/* Cancel button */}
                                <View style={{ alignItems: 'center' }}>
                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.actionButton,
                                            styles.cancelButton,
                                            pressed && { opacity: 0.7 },
                                        ]}
                                        onPress={handleCancel}
                                        disabled={isProcessing}
                                    >
                                        <Ionicons
                                            name="close"
                                            size={28}
                                            color={theme.colors.textSecondary}
                                        />
                                    </Pressable>
                                    <Text style={styles.actionLabel}>
                                        {t('stt.cancel') || 'Cancel'}
                                    </Text>
                                </View>

                                {/* Confirm button */}
                                <View style={{ alignItems: 'center' }}>
                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.actionButton,
                                            styles.confirmButton,
                                            pressed && { opacity: 0.7 },
                                        ]}
                                        onPress={handleConfirm}
                                        disabled={isProcessing}
                                    >
                                        <Ionicons
                                            name="checkmark"
                                            size={28}
                                            color="#FFFFFF"
                                        />
                                    </Pressable>
                                    <Text style={styles.actionLabel}>
                                        {t('stt.send') || 'Send'}
                                    </Text>
                                </View>
                            </View>

                            {/* Slide hint */}
                            <Text style={styles.cancelHint}>
                                {t('stt.slideUpToCancel') || 'Slide up to cancel'}
                            </Text>
                        </Animated.View>
                    </GestureDetector>
                </Animated.View>
            </GestureHandlerRootView>
        </Modal>
    );
});

STTOverlay.displayName = 'STTOverlay';
