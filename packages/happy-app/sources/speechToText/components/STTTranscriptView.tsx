/**
 * STT Transcript View
 *
 * Real-time transcript display with typing indicator.
 */

import * as React from 'react';
import { View, Text, ScrollView } from 'react-native';
import Animated, {
    useAnimatedStyle,
    withRepeat,
    withTiming,
    withSequence,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

// =============================================================================
// Types
// =============================================================================

export interface STTTranscriptViewProps {
    /** Current transcript text (final + partial) */
    transcript: string;
    /** Whether currently processing */
    isProcessing?: boolean;
    /** Placeholder text when empty */
    placeholder?: string;
    /** Maximum height */
    maxHeight?: number;
}

// =============================================================================
// Styles
// =============================================================================

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    scrollView: {
        maxHeight: 150,
    },
    text: {
        fontSize: 18,
        lineHeight: 26,
        color: theme.colors.text,
        ...Typography.default(),
    },
    placeholder: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    cursor: {
        width: 2,
        height: 20,
        backgroundColor: theme.colors.tint,
        marginLeft: 2,
        borderRadius: 1,
    },
    textContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
    },
}));

// =============================================================================
// Typing Cursor Component
// =============================================================================

const TypingCursor = React.memo(() => {
    const styles = stylesheet;

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: withRepeat(
                withSequence(
                    withTiming(1, { duration: 500 }),
                    withTiming(0, { duration: 500 })
                ),
                -1, // Infinite repeat
                false
            ),
        };
    }, []);

    return <Animated.View style={[styles.cursor, animatedStyle]} />;
});

TypingCursor.displayName = 'TypingCursor';

// =============================================================================
// Main Component
// =============================================================================

export const STTTranscriptView = React.memo<STTTranscriptViewProps>(({
    transcript,
    isProcessing = false,
    placeholder = '...',
    maxHeight = 150,
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const scrollViewRef = React.useRef<ScrollView>(null);

    // Auto-scroll to bottom when transcript changes
    React.useEffect(() => {
        if (transcript) {
            scrollViewRef.current?.scrollToEnd({ animated: true });
        }
    }, [transcript]);

    const hasText = transcript.trim().length > 0;

    return (
        <View style={styles.container}>
            <ScrollView
                ref={scrollViewRef}
                style={[styles.scrollView, { maxHeight }]}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
            >
                <View style={styles.textContainer}>
                    <Text style={[styles.text, !hasText && styles.placeholder]}>
                        {hasText ? transcript : placeholder}
                    </Text>
                    {(isProcessing || hasText) && <TypingCursor />}
                </View>
            </ScrollView>
        </View>
    );
});

STTTranscriptView.displayName = 'STTTranscriptView';
