import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export interface MobileKeyboardBarProps {
    onKey(data: string): void;
    visible: boolean;
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

export function MobileKeyboardBar({ onKey, visible }: MobileKeyboardBarProps) {
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
