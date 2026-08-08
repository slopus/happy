import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export interface MobileKeyboardBarProps {
    onKey(data: string): void;
    visible: boolean;
    readOnly?: boolean;
    takingControl?: boolean;
    onTakeControl?(): void;
}

const KEYS: Array<{ label: string; data: string }> = [
    { label: 'Esc', data: '\x1b' },
    { label: 'Ctrl-C', data: '\x03' },
    { label: 'Tab', data: '\t' },
    { label: '↑', data: '\x1b[A' },
    { label: '↓', data: '\x1b[B' },
    { label: '←', data: '\x1b[D' },
    { label: '→', data: '\x1b[C' },
];

export function MobileKeyboardBar({
    onKey,
    visible,
    readOnly = false,
    takingControl = false,
    onTakeControl,
}: MobileKeyboardBarProps) {
    const { theme } = useUnistyles();
    if (!visible) {
        return null;
    }

    const handlePaste = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (text) {
                onKey(text);
            }
        } catch {
            // Clipboard unavailable; ignore.
        }
    };

    if (readOnly) {
        return (
            <View style={styles.bar}>
                <View style={styles.viewerState}>
                    <Ionicons name="lock-closed-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={[styles.viewerLabel, { color: theme.colors.textSecondary }]}>View only</Text>
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Take control of terminal"
                    disabled={takingControl || !onTakeControl}
                    onPress={onTakeControl}
                    style={({ pressed }) => [
                        styles.takeControlButton,
                        { backgroundColor: theme.colors.button.primary.background },
                        pressed && !takingControl ? styles.buttonPressed : null,
                        takingControl ? styles.buttonDisabled : null,
                    ]}
                >
                    {takingControl ? (
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={[styles.takeControlLabel, { color: theme.colors.button.primary.tint }]}>Take control</Text>
                    )}
                </Pressable>
            </View>
        );
    }

    return (
        <View style={styles.bar}>
            {KEYS.map((key) => (
                <Pressable
                    key={key.label}
                    onPress={() => onKey(key.data)}
                    style={styles.key}
                    hitSlop={4}
                >
                    <Text style={[styles.keyLabel, { color: theme.colors.text }]}>
                        {key.label}
                    </Text>
                </Pressable>
            ))}
            <Pressable onPress={handlePaste} style={styles.key} hitSlop={4}>
                <Ionicons name="clipboard-outline" size={18} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-evenly',
        paddingVertical: 8,
        paddingHorizontal: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    viewerState: {
        flex: 1,
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 10,
    },
    viewerLabel: {
        fontSize: 14,
        fontWeight: '500',
    },
    takeControlButton: {
        minWidth: 112,
        height: 40,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
    },
    takeControlLabel: {
        fontSize: 14,
        fontWeight: '600',
    },
    buttonPressed: {
        opacity: 0.92,
        transform: [{ scale: 0.97 }],
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    key: {
        minWidth: 44,
        height: 40,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingHorizontal: 10,
    },
    keyLabel: {
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, monospace',
    },
}));
