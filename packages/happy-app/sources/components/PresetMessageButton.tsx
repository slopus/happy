import React from 'react';
import { Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Platform } from 'react-native';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
        width: 32,
        backgroundColor: theme.colors.surfacePressed,
    },
    pressed: {
        opacity: 0.7,
    },
    text: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
        ...Typography.default('semiBold'),
    },
}));

interface PresetMessageButtonProps {
    text: string;
    index: number;
    onPress: () => void;
    onLongPress?: () => void;
}

export const PresetMessageButton = React.memo(({ text, index, onPress, onLongPress }: PresetMessageButtonProps) => {
    const styles = stylesheet;

    return (
        <Pressable
            style={({ pressed }) => [styles.container, pressed && styles.pressed]}
            onPress={onPress}
            onLongPress={onLongPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            delayLongPress={300}
        >
            <Text style={styles.text}>
                {index + 1}
            </Text>
        </Pressable>
    );
});

PresetMessageButton.displayName = 'PresetMessageButton';
