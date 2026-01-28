import * as React from 'react';
import { View, ViewProps } from 'react-native';

export type ShakeInstance = {
    shake: () => void;
}

export const Shaker = React.memo(React.forwardRef<ShakeInstance, ViewProps>((props, ref) => {
    const baseRef = React.useRef<View>(null);
    React.useImperativeHandle(ref, () => ({
        shake: () => {
            const shakeElement = baseRef.current as any as HTMLDivElement
            let offsets = shakeKeyframes();
            const duration = 300;
            const animations = [];
            for (let i = 0; i < offsets.length; i++) {
                animations.push({
                    transform: `translateX(${offsets[i]}px)`,
                    duration: duration / offsets.length,
                    easing: 'linear'
                });
            }
            shakeElement.animate(animations, {
                duration: duration,
                iterations: 1,
                fill: 'forwards'
            });
        }
    }));

    return (
        <View ref={baseRef} {...props} />
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