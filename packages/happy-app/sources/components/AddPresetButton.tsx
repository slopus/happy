import React from 'react';
import { Platform, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        height: 32,
        width: 32,
        borderWidth: 1,
        borderColor: theme.colors.button.secondary.tint,
        // Android doesn't support dashed, use solid with lower opacity
        ...Platform.select({
            ios: { borderStyle: 'dashed' },
            android: { borderStyle: 'solid', opacity: 0.6 },
            default: { borderStyle: 'dashed' },
        }),
    },
}));

interface AddPresetButtonProps {
    onPress: () => void;
}

export const AddPresetButton = React.memo(({ onPress }: AddPresetButtonProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <TouchableOpacity
            style={styles.container}
            onPress={onPress}
            activeOpacity={0.7}
        >
            <Ionicons
                name="add"
                size={16}
                color={theme.colors.button.secondary.tint}
            />
        </TouchableOpacity>
    );
});

AddPresetButton.displayName = 'AddPresetButton';
