import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        right: 16,
    },
    button: {
        borderRadius: 20,
        width: 56,
        height: 56,
        padding: Platform.select({ web: 16, default: 0 }),
        overflow: 'visible',
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: 'transparent' }),
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: Platform.select({ web: 3.84, default: 0 }),
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 0 }),
        elevation: Platform.select({ web: 5, default: 0 }),
    },
    buttonDefault: {
        backgroundColor: Platform.select({ web: theme.colors.fab.background, default: 'transparent' }),
    },
    buttonPressed: {
        backgroundColor: Platform.select({ web: theme.colors.fab.backgroundPressed, default: 'transparent' }),
        opacity: Platform.select({ web: 1, default: 0.72 }),
        transform: Platform.select({ web: [], default: [{ scale: 0.97 }] }),
    },
    glass: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 20,
        overflow: 'hidden',
        backgroundColor: Platform.select({ web: 'transparent', android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
}));

export const FAB = React.memo(({ onPress }: { onPress: () => void }) => {
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
                {Platform.OS === 'web' ? (
                    <Ionicons name="add" size={24} color={theme.colors.fab.icon} />
                ) : (
                    <MobileGlassSurface interactive intensity={76} style={styles.glass}>
                        {/*
                          `fab.icon` is the inverse of `fab.background` (white on
                          black in light, black on white in dark), so it only reads
                          against that opaque fill — which is the web path. Native
                          replaces the fill with a glass surface tinted like the page
                          behind it, where the same token lands white-on-near-white
                          in light and black-on-near-black in dark. Follow the text
                          color there instead, as the glass composer already does.
                        */}
                        <Ionicons name="add" size={24} color={theme.colors.text} />
                    </MobileGlassSurface>
                )}
            </Pressable>
        </View>
    )
});
