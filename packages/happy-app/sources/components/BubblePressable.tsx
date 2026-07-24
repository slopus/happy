import * as React from 'react';
import {
    GestureResponderEvent,
    Platform,
    Pressable,
    PressableProps,
    PressableStateCallbackType,
    StyleProp,
    ViewStyle,
} from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BubblePressableProps = Omit<PressableProps, 'style'> & {
    style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
    pressedStyle?: StyleProp<ViewStyle>;
    bubbleScale?: number;
};

/**
 * Pressable with the small inflate-and-settle feedback used by mobile glass
 * controls. Large rows can opt into a subtler scale via bubbleScale.
 */
export const BubblePressable = React.memo(({
    style,
    pressedStyle,
    bubbleScale = Platform.OS === 'web' ? 1.01 : 1.025,
    disabled,
    onPressIn,
    onPressOut,
    ...props
}: BubblePressableProps) => {
    const scale = useSharedValue(1);
    const [pressed, setPressed] = React.useState(false);
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
    }));

    const handlePressIn = React.useCallback((event: GestureResponderEvent) => {
        if (!disabled) {
            setPressed(true);
            scale.value = withTiming(bubbleScale, {
                duration: 65,
                easing: Easing.out(Easing.quad),
            });
        }
        onPressIn?.(event);
    }, [bubbleScale, disabled, onPressIn, scale]);

    const handlePressOut = React.useCallback((event: GestureResponderEvent) => {
        setPressed(false);
        scale.value = withSpring(1, {
            damping: 14,
            stiffness: 520,
            mass: 0.4,
            overshootClamping: false,
        });
        onPressOut?.(event);
    }, [onPressOut, scale]);

    // Bubble feedback belongs to the mobile glass controls. Keep desktop
    // interaction identical to the previous plain Pressable behavior.
    if (Platform.OS === 'web') {
        return (
            <Pressable
                {...props}
                disabled={disabled}
                onPressIn={onPressIn}
                onPressOut={onPressOut}
                style={(state) => [
                    typeof style === 'function' ? style(state) : style,
                    state.pressed && pressedStyle,
                ]}
            />
        );
    }

    return (
        <AnimatedPressable
            {...props}
            disabled={disabled}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={[
                typeof style === 'function' ? style({ pressed } as PressableStateCallbackType) : style,
                pressed && pressedStyle,
                animatedStyle,
            ]}
        />
    );
});
