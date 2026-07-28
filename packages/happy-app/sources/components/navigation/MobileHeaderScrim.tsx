import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';

/**
 * The shared native-phone header backdrop. A feathered blur/dim layer keeps
 * controls legible over scrolling content without turning the whole header
 * into a glass surface.
 */
export function MobileHeaderScrim() {
    const { theme } = useUnistyles();
    const blurMaskColors = [
        'rgba(255, 255, 255, 0.72)',
        'rgba(255, 255, 255, 0.44)',
        'rgba(255, 255, 255, 0.10)',
        'rgba(255, 255, 255, 0)',
    ] as const;

    return (
        <View pointerEvents="none" style={styles.fill}>
            <MaskedView
                pointerEvents="none"
                androidRenderingMode="software"
                style={styles.fill}
                maskElement={(
                    <LinearGradient
                        colors={blurMaskColors}
                        locations={[0, 0.34, 0.7, 1]}
                        start={{ x: 0.5, y: 0 }}
                        end={{ x: 0.5, y: 1 }}
                        style={styles.fill}
                    />
                )}
            >
                <BlurView
                    blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                    blurReductionFactor={2}
                    intensity={18}
                    tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                    style={styles.fill}
                />
            </MaskedView>
            <LinearGradient
                pointerEvents="none"
                colors={theme.dark
                    ? ['rgba(0, 0, 0, 0.50)', 'rgba(0, 0, 0, 0.36)', 'rgba(0, 0, 0, 0.12)', 'rgba(0, 0, 0, 0)']
                    : ['rgba(255, 255, 255, 0.68)', 'rgba(255, 255, 255, 0.50)', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0)']}
                locations={[0, 0.34, 0.7, 1]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
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
