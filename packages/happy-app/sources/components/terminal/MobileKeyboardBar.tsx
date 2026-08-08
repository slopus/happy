import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface MobileKeyboardBarProps {
    onKey(data: string): void;
    visible: boolean;
    readOnly?: boolean;
    takingControl?: boolean;
    onTakeControl?(): void;
}

const KEYS: Array<{ label: string; accessibilityLabel: string; data: string }> = [
    { label: 'Esc', accessibilityLabel: 'Escape', data: '\x1b' },
    { label: 'Ctrl-C', accessibilityLabel: 'Control C', data: '\x03' },
    { label: 'Tab', accessibilityLabel: 'Tab', data: '\t' },
    { label: '↑', accessibilityLabel: 'Up arrow', data: '\x1b[A' },
    { label: '↓', accessibilityLabel: 'Down arrow', data: '\x1b[B' },
    { label: '←', accessibilityLabel: 'Left arrow', data: '\x1b[D' },
    { label: '→', accessibilityLabel: 'Right arrow', data: '\x1b[C' },
];

export function MobileKeyboardBar({
    onKey,
    visible,
    readOnly = false,
    takingControl = false,
    onTakeControl,
}: MobileKeyboardBarProps) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
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
            <View style={[styles.bar, { paddingBottom: Math.max(safeArea.bottom, 8) }]}>
                <View style={styles.viewerRow}>
                    <View style={styles.viewerState}>
                        <Ionicons name="lock-closed-outline" size={16} color={theme.colors.textSecondary} />
                        <Text style={[styles.viewerLabel, { color: theme.colors.textSecondary }]}>View only</Text>
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Take control of terminal"
                        accessibilityState={{ disabled: takingControl || !onTakeControl, busy: takingControl }}
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
            </View>
        );
    }

    return (
        <View style={[styles.bar, { paddingBottom: Math.max(safeArea.bottom, 8) }]}>
            <ScrollView
                horizontal
                keyboardShouldPersistTaps="always"
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.keyRow}
            >
                {KEYS.map((key) => (
                    <Pressable
                        key={key.label}
                        accessibilityRole="button"
                        accessibilityLabel={key.accessibilityLabel}
                        onPress={() => onKey(key.data)}
                        style={({ pressed }) => [styles.key, pressed ? styles.keyPressed : null]}
                        hitSlop={4}
                    >
                        <Text style={[styles.keyLabel, { color: theme.colors.text }]}>{key.label}</Text>
                    </Pressable>
                ))}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Paste from clipboard"
                    onPress={() => void handlePaste()}
                    style={({ pressed }) => [styles.key, pressed ? styles.keyPressed : null]}
                    hitSlop={4}
                >
                    <Ionicons name="clipboard-outline" size={18} color={theme.colors.text} />
                </Pressable>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        minHeight: 56,
        paddingTop: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    viewerRow: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        gap: 8,
    },
    viewerState: {
        flex: 1,
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
    keyRow: {
        minWidth: '100%',
        minHeight: 40,
        alignItems: 'center',
        paddingHorizontal: 6,
        gap: 6,
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
    keyPressed: {
        opacity: 0.86,
        transform: [{ scale: 0.97 }],
    },
    keyLabel: {
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, monospace',
    },
}));
