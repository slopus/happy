import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';

export type MobileHeaderScrimVariant = 'subtle' | 'strong';
export type MobileHeaderScrimEdge = 'top' | 'bottom';

// Shared by headers that keep a strong material visible at rest and deepen it
// slightly as scrolling content moves underneath.
export const MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY = 0.80;
export const MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY = 0.96;

/**
 * The shared native-phone header backdrop. A feathered blur/dim layer keeps
 * controls legible over scrolling content without turning the whole header
 * into a glass surface. The strong variant is used for the chat title, where
 * the text must stay readable without its own capsule.
 */
export function MobileHeaderScrim({
    variant = 'subtle',
    edge = 'top',
}: {
    variant?: MobileHeaderScrimVariant;
    edge?: MobileHeaderScrimEdge;
}) {
    const { theme } = useUnistyles();
    const isStrong = variant === 'strong';
    const gradientStart = edge === 'bottom' ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
    const gradientEnd = edge === 'bottom' ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
    const strongBlurMaskColors = [
        'rgba(255, 255, 255, 1)',
        'rgba(255, 255, 255, 0.94)',
        'rgba(255, 255, 255, 0.48)',
        'rgba(255, 255, 255, 0)',
    ] as const;
    const subtleBlurMaskColors = [
        'rgba(255, 255, 255, 0.72)',
        'rgba(255, 255, 255, 0.44)',
        'rgba(255, 255, 255, 0.10)',
        'rgba(255, 255, 255, 0)',
    ] as const;
    const blurMaskColors = isStrong ? strongBlurMaskColors : subtleBlurMaskColors;

    return (
        <View pointerEvents="none" style={styles.fill}>
            <MaskedView
                pointerEvents="none"
                androidRenderingMode="software"
                style={styles.fill}
                maskElement={(
                    <LinearGradient
                        colors={blurMaskColors}
                        locations={isStrong ? [0, 0.20, 0.68, 1] : [0, 0.34, 0.7, 1]}
                        start={gradientStart}
                        end={gradientEnd}
                        style={styles.fill}
                    />
                )}
            >
                <BlurView
                    blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                    blurReductionFactor={2}
                    intensity={isStrong ? 88 : 18}
                    tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                    style={styles.fill}
                />
            </MaskedView>
            <LinearGradient
                pointerEvents="none"
                colors={theme.dark
                    ? isStrong
                        ? ['rgba(0, 0, 0, 0.20)', 'rgba(0, 0, 0, 0.14)', 'rgba(0, 0, 0, 0.05)', 'rgba(0, 0, 0, 0)']
                        : ['rgba(0, 0, 0, 0.50)', 'rgba(0, 0, 0, 0.36)', 'rgba(0, 0, 0, 0.12)', 'rgba(0, 0, 0, 0)']
                    : isStrong
                        ? ['rgba(255, 255, 255, 0.34)', 'rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0)']
                        : ['rgba(255, 255, 255, 0.68)', 'rgba(255, 255, 255, 0.50)', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0)']}
                locations={isStrong ? [0, 0.34, 0.80, 1] : [0, 0.34, 0.7, 1]}
                start={gradientStart}
                end={gradientEnd}
                style={styles.fill}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: {
        ...StyleSheet.absoluteFillObject,
    },
});
