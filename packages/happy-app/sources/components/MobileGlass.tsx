import * as React from 'react';
import { Platform, StyleProp, StyleSheet as RNStyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, type GlassStyle } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';
import { isRunningOnMac } from '@/utils/platform';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

type MobileGlassMaterial = 'liquid' | 'static' | 'frosted';

type MobileGlassSurfaceProps = ViewProps & {
    enabled?: boolean;
    intensity?: number;
    interactive?: boolean;
    nativeEffect?: boolean;
    material?: MobileGlassMaterial;
    glassEffectStyle?: GlassStyle;
    tintColor?: string;
    style?: StyleProp<ViewStyle>;
};

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);
const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/**
 * Performance-aware material surface. Interactive controls and explicit
 * `nativeEffect` surfaces use Liquid Glass/material blur; `material="static"`
 * opts into a calm, non-refractive blur without the Liquid Glass highlight.
 * `material="frosted"` adds a denser tint and blur for writing surfaces where
 * background content must not compete with the foreground text.
 * Content surfaces remain opaque so glass stays a distinct functional layer.
 */
export function MobileGlassSurface(props: MobileGlassSurfaceProps) {
    if (props.interactive && Platform.OS !== 'web' && !isRunningOnMac()) {
        return <InteractiveMobileGlassSurface {...props} />;
    }
    return <MobileGlassSurfaceBase {...props} />;
}

function InteractiveMobileGlassSurface({
    onTouchStart,
    onTouchEnd,
    onTouchCancel,
    style,
    ...props
}: MobileGlassSurfaceProps) {
    const pressScale = useSharedValue(1);
    const bubbleStyle = useAnimatedStyle(() => ({
        transform: [{ scale: pressScale.value }],
    }));
    const releaseBubble = React.useCallback(() => {
        pressScale.value = withSpring(1, {
            damping: 14,
            stiffness: 520,
            mass: 0.4,
            overshootClamping: false,
        });
    }, [pressScale]);
    const handleTouchStart = React.useCallback<NonNullable<ViewProps['onTouchStart']>>((event) => {
        pressScale.value = withTiming(1.035, {
            duration: 65,
            easing: Easing.out(Easing.quad),
        });
        onTouchStart?.(event);
    }, [onTouchStart, pressScale]);
    const handleTouchEnd = React.useCallback<NonNullable<ViewProps['onTouchEnd']>>((event) => {
        releaseBubble();
        onTouchEnd?.(event);
    }, [onTouchEnd, releaseBubble]);
    const handleTouchCancel = React.useCallback<NonNullable<ViewProps['onTouchCancel']>>((event) => {
        releaseBubble();
        onTouchCancel?.(event);
    }, [onTouchCancel, releaseBubble]);

    return (
        <MobileGlassSurfaceBase
            {...props}
            interactive
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            style={[style, bubbleStyle]}
            animated
        />
    );
}

function MobileGlassSurfaceBase({
    enabled = Platform.OS !== 'web' && !isRunningOnMac(),
    intensity = 72,
    interactive = false,
    nativeEffect = interactive,
    material = 'liquid',
    glassEffectStyle = 'clear',
    tintColor,
    style,
    children,
    animated = false,
    ...props
}: MobileGlassSurfaceProps & { animated?: boolean }) {
    const { theme } = useUnistyles();
    const usesStaticMaterial = nativeEffect && material !== 'liquid';
    const usesFrostedMaterial = nativeEffect && material === 'frosted';

    if (!enabled || Platform.OS === 'web' || isRunningOnMac()) {
        return animated ? (
            <Animated.View
                {...props}
                style={style}
            >
                {children}
            </Animated.View>
        ) : (
            <View {...props} style={style}>{children}</View>
        );
    }

    // Liquid Glass is navigation chrome, not a general card background. Keeping
    // content opaque also avoids compositing dozens of translucent layers.
    if (!nativeEffect) {
        return animated ? (
            <Animated.View
                {...props}
                style={[{ backgroundColor: theme.colors.surface }, style]}
            >
                {children}
            </Animated.View>
        ) : (
            <View {...props} style={[{ backgroundColor: theme.colors.surface }, style]}>
                {children}
            </View>
        );
    }

    const surfaceOverlay = usesStaticMaterial ? (
        <View
            pointerEvents="none"
            style={[
                RNStyleSheet.absoluteFill,
                {
                    backgroundColor: theme.dark
                        ? usesFrostedMaterial ? 'rgba(20, 20, 22, 0.82)' : 'rgba(44, 44, 47, 0.62)'
                        : usesFrostedMaterial ? 'rgba(255, 255, 255, 0.82)' : 'rgba(255, 255, 255, 0.66)',
                },
            ]}
        />
    ) : (
        <LinearGradient
            pointerEvents="none"
            colors={theme.dark
                ? ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.018)', 'rgba(255,255,255,0.055)']
                : ['rgba(255,255,255,0.76)', 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0.42)']}
            locations={[0, 0.48, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={RNStyleSheet.absoluteFill}
        />
    );

    if (Platform.OS === 'ios' && isGlassEffectAPIAvailable() && !usesStaticMaterial) {
        return animated ? (
            <AnimatedGlassView
                {...props}
                glassEffectStyle={glassEffectStyle}
                colorScheme={theme.dark ? 'dark' : 'light'}
                tintColor={tintColor ?? theme.colors.glass.tint}
                isInteractive={interactive}
                style={style}
            >
                {surfaceOverlay}
                {children}
            </AnimatedGlassView>
        ) : (
            <GlassView
                {...props}
                glassEffectStyle={glassEffectStyle}
                colorScheme={theme.dark ? 'dark' : 'light'}
                tintColor={tintColor ?? theme.colors.glass.tint}
                isInteractive={interactive}
                style={style}
            >
                {surfaceOverlay}
                {children}
            </GlassView>
        );
    }

    if (Platform.OS === 'ios') {
        return animated ? (
            <AnimatedBlurView
                {...props}
                intensity={Math.min(intensity, usesFrostedMaterial ? 42 : usesStaticMaterial ? 18 : 36)}
                tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                style={style}
            >
                {surfaceOverlay}
                {children}
            </AnimatedBlurView>
        ) : (
            <BlurView
                {...props}
                intensity={Math.min(intensity, usesFrostedMaterial ? 42 : usesStaticMaterial ? 18 : 36)}
                tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                style={style}
            >
                {surfaceOverlay}
                {children}
            </BlurView>
        );
    }

    return animated ? (
        <Animated.View
            {...props}
            style={[{ backgroundColor: theme.colors.glass.background }, style]}
        >
            {surfaceOverlay}
            {children}
        </Animated.View>
    ) : (
        <View
            {...props}
            style={[{ backgroundColor: theme.colors.glass.background }, style]}
        >
            {surfaceOverlay}
            {children}
        </View>
    );
}

export function MobileGlassBackdrop({ enabled = Platform.OS !== 'web' && !isRunningOnMac() }: { enabled?: boolean }) {
    const { theme } = useUnistyles();

    if (!enabled || isRunningOnMac()) {
        return null;
    }

    return (
        <View pointerEvents="none" style={RNStyleSheet.absoluteFill}>
            <LinearGradient
                colors={theme.colors.glass.backdrop}
                locations={[0, 0.52, 1]}
                start={{ x: 0.05, y: 0 }}
                end={{ x: 0.95, y: 1 }}
                style={RNStyleSheet.absoluteFill}
            />
            <View
                style={[
                    styles.glow,
                    styles.primaryGlow,
                    { backgroundColor: theme.colors.glass.glowPrimary },
                ]}
            />
            <View
                style={[
                    styles.glow,
                    styles.secondaryGlow,
                    { backgroundColor: theme.colors.glass.glowSecondary },
                ]}
            />
        </View>
    );
}

const styles = RNStyleSheet.create({
    glow: {
        position: 'absolute',
        borderRadius: 999,
    },
    primaryGlow: {
        width: 280,
        height: 280,
        top: -96,
        right: -116,
    },
    secondaryGlow: {
        width: 320,
        height: 320,
        bottom: -148,
        left: -156,
    },
});
