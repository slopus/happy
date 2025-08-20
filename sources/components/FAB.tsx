import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        right: 16,
    },
    button: {
        borderRadius: 20,
        width: 56,
        height: 56,
        padding: 16,
        shadowColor: theme.colors.fabShadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
    },
    buttonDefault: {
        backgroundColor: theme.colors.fabBackground,
    },
    buttonPressed: {
        backgroundColor: theme.colors.fabBackgroundPressed,
    },
    icon: {
        color: theme.colors.fabIcon,
    },
}));

export const FAB = React.memo(({ onPress }: { onPress: () => void }) => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    return (
        <View
            style={[
                styles.container,
                { bottom: safeArea.bottom + 16 }
            ]}
        >
            <Pressable
                style={({ pressed }) => [
                    styles.button,
                    pressed ? styles.buttonPressed : styles.buttonDefault
                ]}
                onPress={onPress}
            >
                <Ionicons name="add" size={24} style={styles.icon} />
            </Pressable>
        </View>
    )
});