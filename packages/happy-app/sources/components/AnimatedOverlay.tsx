import * as React from 'react';
import { Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import Animated, {
    Easing,
    FadeIn,
    FadeInDown,
    FadeOut,
    FadeOutUp,
    LinearTransition,
    ReduceMotion,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

const enterEasing = Easing.out(Easing.cubic);
const exitEasing = Easing.in(Easing.cubic);

const backdropEntering = FadeIn
    .duration(180)
    .easing(enterEasing)
    .reduceMotion(ReduceMotion.System);

const backdropExiting = FadeOut
    .duration(140)
    .easing(exitEasing)
    .reduceMotion(ReduceMotion.System);

const popupEntering = FadeIn
    .duration(190)
    .easing(enterEasing)
    .withInitialValues({
        opacity: 0,
        transform: [{ scale: 0.96 }, { translateY: 8 }],
    })
    .reduceMotion(ReduceMotion.System);

const popupExiting = FadeOut
    .duration(140)
    .easing(exitEasing)
    .reduceMotion(ReduceMotion.System);

const collapsibleEntering = FadeInDown
    .duration(180)
    .easing(enterEasing)
    .reduceMotion(ReduceMotion.System);

const collapsibleExiting = FadeOutUp
    .duration(130)
    .easing(exitEasing)
    .reduceMotion(ReduceMotion.System);

const collapsibleLayout = LinearTransition
    .duration(180)
    .easing(enterEasing)
    .reduceMotion(ReduceMotion.System);

export function AnimatedBlurBackdrop({
    blurIntensity = 42,
    dimColor,
    interactive = true,
    onPress,
    style,
}: {
    blurIntensity?: number;
    dimColor?: string;
    interactive?: boolean;
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();

    return (
        <Animated.View
            entering={backdropEntering}
            exiting={backdropExiting}
            pointerEvents="box-none"
            style={[StyleSheet.absoluteFill, style]}
        >
            <BlurView
                blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                blurReductionFactor={2}
                intensity={blurIntensity}
                pointerEvents="none"
                tint={theme.dark ? 'systemMaterialDark' : 'systemMaterialLight'}
                style={StyleSheet.absoluteFill}
            />
            <View
                pointerEvents="none"
                style={[
                    StyleSheet.absoluteFill,
                    {
                        backgroundColor: dimColor ?? (theme.dark
                            ? 'rgba(0, 0, 0, 0.34)'
                            : 'rgba(255, 255, 255, 0.18)'),
                    },
                ]}
            />
            <Pressable
                onPress={onPress}
                pointerEvents={interactive ? 'auto' : 'none'}
                style={StyleSheet.absoluteFill}
            />
        </Animated.View>
    );
}

export function AnimatedClickAwayBackdrop({
    dimColor = 'transparent',
    onPress,
    style,
}: {
    dimColor?: string;
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    return (
        <Animated.View
            entering={backdropEntering}
            exiting={backdropExiting}
            pointerEvents="box-none"
            style={[StyleSheet.absoluteFill, style]}
        >
            {dimColor !== 'transparent' && (
                <View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, { backgroundColor: dimColor }]}
                />
            )}
            <Pressable onPress={onPress} style={StyleSheet.absoluteFill} />
        </Animated.View>
    );
}

export function LocalBlurHalo({
    blurIntensity = 34,
    borderRadius = 30,
    dimColor,
    expansion = 14,
    style,
}: {
    blurIntensity?: number;
    borderRadius?: number;
    dimColor?: string;
    expansion?: number;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();
    const maskExpansion = expansion * 2.5;
    const maskShadowRadius = expansion * 1.35;

    return (
        <MaskedView
            androidRenderingMode="software"
            maskElement={(
                <View style={StyleSheet.absoluteFill}>
                    <View
                        style={[
                            styles.localBlurMaskCore,
                            {
                                top: maskExpansion,
                                right: maskExpansion,
                                bottom: maskExpansion,
                                left: maskExpansion,
                                borderRadius,
                                shadowRadius: maskShadowRadius,
                                boxShadow: `0 0 ${maskShadowRadius * 2}px rgba(255, 255, 255, 1)`,
                            },
                        ]}
                    />
                </View>
            )}
            pointerEvents="none"
            style={[
                styles.localBlurHalo,
                {
                    top: -maskExpansion,
                    right: -maskExpansion,
                    bottom: -maskExpansion,
                    left: -maskExpansion,
                },
                style,
            ]}
        >
            <BlurView
                blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                blurReductionFactor={2}
                intensity={blurIntensity}
                tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                style={StyleSheet.absoluteFill}
            />
            <View
                pointerEvents="none"
                style={[
                    StyleSheet.absoluteFill,
                    {
                        backgroundColor: dimColor ?? (theme.dark
                            ? 'rgba(0, 0, 0, 0.10)'
                            : 'rgba(255, 255, 255, 0.08)'),
                    },
                ]}
            />
        </MaskedView>
    );
}

export function AnimatedPopup({
    children,
    style,
}: {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    return (
        <Animated.View
            entering={popupEntering}
            exiting={popupExiting}
            style={style}
        >
            {children}
        </Animated.View>
    );
}

export function AnimatedCollapsible({
    children,
    style,
}: {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    return (
        <Animated.View
            entering={collapsibleEntering}
            exiting={collapsibleExiting}
            layout={collapsibleLayout}
            style={style}
        >
            {children}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    localBlurHalo: {
        position: 'absolute',
    },
    localBlurMaskCore: {
        position: 'absolute',
        backgroundColor: '#FFFFFF',
        shadowColor: '#FFFFFF',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
    },
});
