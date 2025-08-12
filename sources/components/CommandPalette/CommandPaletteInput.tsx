import React from 'react';
import { View, TextInput, StyleSheet, Platform } from 'react-native';
import { Typography } from '@/constants/Typography';

interface CommandPaletteInputProps {
    value: string;
    onChangeText: (text: string) => void;
    onKeyPress?: (key: string) => void;
    inputRef?: React.RefObject<TextInput | null>;
}

export function CommandPaletteInput({ value, onChangeText, onKeyPress, inputRef }: CommandPaletteInputProps) {
    const handleKeyDown = React.useCallback((e: any) => {
        if (Platform.OS === 'web' && onKeyPress) {
            const key = e.nativeEvent.key;
            
            // Handle navigation keys
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) {
                e.preventDefault();
                e.stopPropagation();
                onKeyPress(key);
            }
        }
    }, [onKeyPress]);

    return (
        <View style={styles.container}>
            <TextInput
                ref={inputRef}
                style={[styles.input, Typography.default()]}
                value={value}
                onChangeText={onChangeText}
                placeholder="Type a command or search..."
                placeholderTextColor="#999"
                autoFocus
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="go"
                onKeyPress={handleKeyDown}
                blurOnSubmit={false}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(0, 0, 0, 0.06)',
        backgroundColor: '#FAFAFA',
    },
    input: {
        paddingHorizontal: 24,
        paddingVertical: 20,
        fontSize: 18,
        color: '#000',
        letterSpacing: -0.2,
    },
});