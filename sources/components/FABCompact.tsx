import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    button: {
        width: 48,
        height: 48,
        borderRadius: 24,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 3.84,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonDefault: {
        backgroundColor: theme.colors.fab.background,
    },
    buttonPressed: {
        backgroundColor: theme.colors.fab.backgroundPressed,
    },
}));

export const FABCompact = React.memo(({ onPress }: { onPress: () => void }) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    return (
        <View style={[stylesheet.container, { bottom: safeArea.bottom + 16 }]}>
            <Pressable
                style={({ pressed }) => [
                    stylesheet.button,
                    pressed ? stylesheet.buttonPressed : stylesheet.buttonDefault
                ]}
                onPress={onPress}
            >
                <Ionicons name="add" size={28} color={theme.colors.fab.icon} />
            </Pressable>
        </View>
    );
});
