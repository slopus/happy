import * as React from 'react';
import MaskedView from '@react-native-masked-view/masked-view';
import { Animated, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';

export type MobileHeaderScrimVariant = 'subtle' | 'strong' | 'home';
export type MobileHeaderScrimEdge = 'top' | 'bottom';

/**
 * Scrim strengths, applied as a multiplier over the gradient's own peak.
 *
 * These scale the wash itself rather than a wrapping view. A translucent
 * ancestor makes iOS re-render UIVisualEffectView against an empty backdrop,
 * so the live blur stays fully opaque and only its gradient mask fades it.
 */
export const MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY = 0.80;
export const MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY = 0.96;
export const MOBILE_HOME_SCRIM_OVERLAY_OPACITY = 1;

type GradientStops = {
    colors: readonly [string, string, ...string[]];
    locations: readonly [number, number, ...number[]];
};

// A few hand-authored stops leave visible bands. Sampling the curve keeps the
// fade continuous while still matching Telegram's fast rise at the content
// edge and gentle arrival at the plateau.
const FEATHER_STEPS = 24;

/** Alpha at the outer edge, before the ramp begins. */
const STRONG_TINT_PEAK_LIGHT = 0.76;
const STRONG_TINT_PEAK_DARK = 0.55;
const SUBTLE_TINT_PEAK_LIGHT = 0.55;
const SUBTLE_TINT_PEAK_DARK = 0.40;
const EDGE_BLUR_INTENSITY = 8;

/**
 * How tall the ramp is, in points. Expressed as a length rather than a
 * fraction because the three scrims differ in height, and a fraction would
 * give each of them a different-looking edge. Measured height turns this back
 * into a gradient stop; until the first layout lands, fall back to a fraction.
 */
export const MOBILE_HEADER_EDGE_RAMP_POINTS = 36;
const FALLBACK_FEATHER_START = 0.60;

function feather(rgb: string, peak: number, hold: number): GradientStops {
    const colors: string[] = [];
    const locations: number[] = [];
    for (let step = 0; step <= FEATHER_STEPS; step += 1) {
        const t = step / FEATHER_STEPS;
        const p = t <= hold ? 0 : (t - hold) / (1 - hold);
        // 1 - p^1.67 reaches 40 / 76 of the peak 13 pt in from a
        // 36 pt edge, then eases smoothly into the constant plateau.
        const falloff = 1 - Math.pow(p, 1.67);
        colors.push(`rgba(${rgb}, ${(peak * falloff).toFixed(4)})`);
        locations.push(t);
    }
    return {
        colors: colors as unknown as GradientStops['colors'],
        locations: locations as unknown as GradientStops['locations'],
    };
}

const TOP_START = { x: 0.5, y: 0 };
const TOP_END = { x: 0.5, y: 1 };
const BOTTOM_START = { x: 0.5, y: 1 };
const BOTTOM_END = { x: 0.5, y: 0 };

/**
 * The shared native-phone header backdrop: a single dim gradient that keeps
 * floating controls legible over scrolling content. Full strength at the outer
 * edge, falling continuously to nothing where it meets the content.
 */
export function MobileHeaderScrim({
    variant = 'subtle',
    edge = 'top',
    overlayOpacity,
}: {
    variant?: MobileHeaderScrimVariant;
    edge?: MobileHeaderScrimEdge;
    overlayOpacity?: number | Animated.Value | Animated.AnimatedInterpolation<number>;
}) {
    const { theme } = useUnistyles();
    const isStrong = variant !== 'subtle';
    const [height, setHeight] = React.useState(0);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setHeight(event.nativeEvent.layout.height);
    }, []);

    const featherStart = height > MOBILE_HEADER_EDGE_RAMP_POINTS
        ? 1 - MOBILE_HEADER_EDGE_RAMP_POINTS / height
        : FALLBACK_FEATHER_START;

    const tint = React.useMemo(() => {
        const rgb = theme.dark ? '0, 0, 0' : '255, 255, 255';
        const peak = theme.dark
            ? isStrong ? STRONG_TINT_PEAK_DARK : SUBTLE_TINT_PEAK_DARK
            : isStrong ? STRONG_TINT_PEAK_LIGHT : SUBTLE_TINT_PEAK_LIGHT;
        return feather(rgb, peak, featherStart);
    }, [featherStart, isStrong, theme.dark]);
    const blurMask = React.useMemo(
        () => feather('255, 255, 255', 1, featherStart),
        [featherStart],
    );

    const resolvedOverlayOpacity = overlayOpacity
        ?? (variant === 'home' ? MOBILE_HOME_SCRIM_OVERLAY_OPACITY : 1);

    // Material 3 uses a tonal app bar, not backdrop blur. Android headers
    // render their opaque surface in Header / ChatHeaderView instead.
    if (Platform.OS !== 'ios') {
        return null;
    }

    return (
        <View
            pointerEvents="none"
            onLayout={onLayout}
            style={styles.fill}
        >
            <MaskedView
                style={styles.fill}
                maskElement={(
                    <LinearGradient
                        colors={blurMask.colors}
                        locations={blurMask.locations}
                        start={edge === 'bottom' ? BOTTOM_START : TOP_START}
                        end={edge === 'bottom' ? BOTTOM_END : TOP_END}
                        style={styles.fill}
                    />
                )}
            >
                <BlurView
                    intensity={EDGE_BLUR_INTENSITY}
                    tint={theme.dark ? 'dark' : 'light'}
                    style={styles.fill}
                />
            </MaskedView>
            <Animated.View style={[styles.fill, { opacity: resolvedOverlayOpacity }]}>
                <LinearGradient
                    colors={tint.colors}
                    locations={tint.locations}
                    start={edge === 'bottom' ? BOTTOM_START : TOP_START}
                    end={edge === 'bottom' ? BOTTOM_END : TOP_END}
                    style={styles.fill}
                />
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    fill: {
        ...StyleSheet.absoluteFillObject,
    },
});
