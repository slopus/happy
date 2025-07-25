import * as React from 'react';
import { Animated, View, ViewProps, useAnimatedValue } from 'react-native';

export type ShakeInstance = {
    shake: () => void;
}

export const Shaker = React.memo(React.forwardRef<ShakeInstance, ViewProps>((props, ref) => {
    const { style, ...rest } = props;
    const baseRef = React.useRef<View>(null);
    const shakeValue = useAnimatedValue(0, { useNativeDriver: true });
    React.useImperativeHandle(ref, () => ({
        shake: () => {
            let offsets = shakeKeyframes();
            let duration = 300;
            let animations: Animated.CompositeAnimation[] = [];
            for (let i = 0; i < offsets.length; i++) {
                animations.push(Animated.timing(shakeValue, {
                    toValue: offsets[i],
                    duration: duration / offsets.length,
                    useNativeDriver: true
                }));
            }
            Animated.sequence(animations).start();
        }
    }));
    return (
        <Animated.View ref={baseRef} style={[{ transform: [{ translateX: shakeValue }] }, style]} {...rest} />
    );
}));

function shakeKeyframes(amplitude: number = 3.0, count: number = 4, decay: boolean = false) {
    let keyframes: number[] = [];
    keyframes.push(0);
    for (let i = 0; i < count; i++) {
        let sign = (i % 2 == 0) ? 1.0 : -1.0;
        let multiplier = decay ? (1.0 / (i + 1)) : 1.0;
        keyframes.push(amplitude * sign * multiplier);
    }
    keyframes.push(0);
    return keyframes;
}