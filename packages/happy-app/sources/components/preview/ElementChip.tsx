import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { type SelectedElement } from 'happy-wire';

interface ElementChipProps {
    element: SelectedElement;
    onDismiss: () => void;
    onPress?: () => void;
}

/**
 * Truncate text to a maximum length, appending ellipsis if needed.
 */
function truncate(text: string, max: number): string {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= max) return trimmed;
    return trimmed.slice(0, max) + '\u2026';
}

/**
 * Format a SelectedElement into a text block that can be prepended to user messages.
 *
 * Example output:
 *   [Selected element: <div.card.active#main> "Some text content..." at div > section > div.card]
 *   Source: App.tsx:42
 */
export function formatElementForMessage(element: SelectedElement): string {
    let descriptor = `<${element.tag}`;
    if (element.classes.length > 0) {
        descriptor += '.' + element.classes.join('.');
    }
    if (element.id) {
        descriptor += '#' + element.id;
    }
    descriptor += '>';

    const textSnippet = element.text.trim()
        ? ` "${truncate(element.text, 60)}"`
        : '';

    let line = `[Selected element: ${descriptor}${textSnippet} at ${element.selector}]`;

    if (element.sourceFile) {
        const loc = element.sourceLine != null
            ? `${element.sourceFile}:${element.sourceLine}`
            : element.sourceFile;
        line += `\nSource: ${loc}`;
    }

    return line;
}

export const ElementChip = React.memo(({ element, onDismiss, onPress }: ElementChipProps) => {
    const { theme } = useUnistyles();

    // Build class string: ".class1.class2" (max 2 classes)
    const classInfo = element.classes.length > 0
        ? '.' + element.classes.slice(0, 2).join('.')
        : null;

    // Truncated text snippet
    const textSnippet = element.text.trim()
        ? `"${truncate(element.text, 30)}"`
        : null;

    return (
        <Pressable onPress={onPress} disabled={!onPress} style={styles.container}>
            {/* Code icon */}
            <Ionicons
                name="code-outline"
                size={14}
                color={theme.colors.textSecondary}
            />

            {/* Tag label */}
            <Text style={[styles.tagLabel, { color: theme.colors.text }]}>
                {'<'}{element.tag}{'>'}
            </Text>

            {/* Class info */}
            {classInfo && (
                <Text
                    style={[styles.classInfo, { color: theme.colors.textSecondary }]}
                    numberOfLines={1}
                >
                    {classInfo}
                </Text>
            )}

            {/* Text snippet */}
            {textSnippet && (
                <Text
                    style={[styles.textSnippet, { color: theme.colors.textSecondary }]}
                    numberOfLines={1}
                >
                    {textSnippet}
                </Text>
            )}

            {/* Dismiss button */}
            <Pressable
                onPress={onDismiss}
                hitSlop={8}
                style={({ pressed }) => [
                    styles.dismissButton,
                    pressed && styles.dismissButtonPressed,
                ]}
            >
                <Ionicons
                    name="close-circle"
                    size={16}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfacePressed,
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 6,
        maxHeight: 44,
    },
    tagLabel: {
        fontSize: 12,
        ...Typography.mono('semiBold'),
    },
    classInfo: {
        fontSize: 11,
        ...Typography.mono(),
    },
    textSnippet: {
        fontSize: 11,
        flexShrink: 1,
        ...Typography.default(),
    },
    dismissButton: {
        marginLeft: 'auto',
    },
    dismissButtonPressed: {
        opacity: 0.7,
    },
}));
