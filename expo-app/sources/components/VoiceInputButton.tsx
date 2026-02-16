/**
 * VoiceInputButton
 *
 * A pressable button that replaces the text input when in voice mode.
 * Supports long press to start recording and gesture tracking.
 */

import React, { useRef, useCallback } from 'react';
import {
    View,
    Text,
    Pressable,
    GestureResponderEvent,
    Platform,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { hapticsLight, hapticsError } from './haptics';
import { t } from '@/text';

interface VoiceInputButtonProps {
    /** Whether currently recording */
    isRecording: boolean;
    /** Called when long press starts */
    onLongPressStart: () => void;
    /** Called when touch ends */
    onPressEnd: () => void;
    /** Called when gesture moves (dx, dy from start) */
    onGestureMove: (dx: number, dy: number) => void;
    /** Disabled state */
    disabled?: boolean;
}

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = ({
    isRecording,
    onLongPressStart,
    onPressEnd,
    onGestureMove,
    disabled = false,
}) => {
    const { theme } = useUnistyles();
    const recordingColor = theme.dark ? theme.colors.button.primary.tint : theme.colors.button.primary.background;
    const startPositionRef = useRef<{ x: number; y: number } | null>(null);
    const lastPositionRef = useRef<{ x: number; y: number } | null>(null);
    const isLongPressTriggeredRef = useRef(false);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handlePressIn = useCallback((event: GestureResponderEvent) => {
        if (disabled) return;

        const startPosition = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
        };
        startPositionRef.current = startPosition;
        lastPositionRef.current = startPosition;
        isLongPressTriggeredRef.current = false;

        // Start long press timer (300ms)
        longPressTimerRef.current = setTimeout(() => {
            isLongPressTriggeredRef.current = true;
            hapticsLight();
            onLongPressStart();
            const start = startPositionRef.current;
            const last = lastPositionRef.current;
            if (start && last) {
                onGestureMove(last.x - start.x, last.y - start.y);
            }
        }, 300);
    }, [disabled, onLongPressStart]);

    const handlePressOut = useCallback(() => {
        // Clear long press timer if not triggered
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }

        // Only call onPressEnd if long press was triggered
        if (isLongPressTriggeredRef.current) {
            onPressEnd();
        }

        startPositionRef.current = null;
        lastPositionRef.current = null;
        isLongPressTriggeredRef.current = false;
    }, [onPressEnd]);

    const handleMove = useCallback((event: GestureResponderEvent) => {
        if (!startPositionRef.current) return;

        lastPositionRef.current = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
        };

        if (!isLongPressTriggeredRef.current) return;

        const dx = lastPositionRef.current.x - startPositionRef.current.x;
        const dy = lastPositionRef.current.y - startPositionRef.current.y;
        onGestureMove(dx, dy);
    }, [onGestureMove]);

    return (
        <Pressable
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            onTouchMove={handleMove}
            onResponderMove={handleMove}
            pressRetentionOffset={{ top: 1000, bottom: 1000, left: 1000, right: 1000 }}
            disabled={disabled}
            style={({ pressed }) => [
                styles.button,
                {
                    backgroundColor: isRecording
                        ? recordingColor
                        : pressed
                            ? theme.colors.surfacePressed
                            : theme.colors.surface,
                    opacity: disabled ? 0.5 : 1,
                }
            ]}
        >
            <View style={styles.content}>
                <Ionicons
                    name="mic"
                    size={20}
                    color={isRecording ? theme.colors.button.primary.tint : theme.colors.text}
                />
                <Text style={[
                    styles.text,
                    { color: isRecording ? theme.colors.button.primary.tint : theme.colors.text }
                ]}>
                    {isRecording
                        ? (t('voiceInput.recording') || '松开 发送')
                        : (t('voiceInput.holdToSpeak') || '按住 说话')
                    }
                </Text>
            </View>
        </Pressable>
    );
};

const styles = StyleSheet.create((theme) => ({
    button: {
        flex: 1,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        marginHorizontal: 8,
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    text: {
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
}));
