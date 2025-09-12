import * as React from 'react';
import { View, Pressable, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        left: 16,
        right: 16,
    },
    button: {
        borderRadius: 12,
        paddingVertical: 16,
        paddingHorizontal: 20,
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
    text: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.fab.icon,
    },
}));

export const FABWide = React.memo(({ onPress }: { onPress: () => void }) => {
    const { theme } = useUnistyles();
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
                <Text style={styles.text}>{t('newSession.title')}</Text>
            </Pressable>
        </View>
    )
});