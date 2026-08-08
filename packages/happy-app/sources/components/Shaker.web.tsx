import * as React from 'react';
import { View, ViewProps } from 'react-native';

export type ShakeInstance = {
    shake: () => void;
}

export const Shaker = React.memo(React.forwardRef<ShakeInstance, ViewProps>((props, ref) => {
    const baseRef = React.useRef<View>(null);
    const animationRef = React.useRef<Animation | null>(null);
    React.useEffect(() => () => animationRef.current?.cancel(), []);
    React.useImperativeHandle(ref, () => ({
        shake: () => {
            const shakeElement = baseRef.current as any as HTMLDivElement;
            if (!shakeElement) return;

            const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const currentTranslateX = readTranslateX(shakeElement);
            animationRef.current?.cancel();

            const keyframes: Keyframe[] = reduceMotion
                ? [
                    { opacity: 1 },
                    { opacity: 0.72 },
                    { opacity: 1 },
                ]
                : shakeKeyframes().map((offset, index) => ({
                    transform: `translateX(${index === 0 ? currentTranslateX : offset}px)`,
                }));
            const animation = shakeElement.animate(keyframes, {
                duration: reduceMotion ? 160 : 260,
                easing: 'linear',
                iterations: 1,
                fill: 'forwards',
            });
            animationRef.current = animation;
            void animation.finished.catch(() => undefined).then(() => {
                if (animationRef.current === animation) {
                    animationRef.current = null;
                }
            });
        }
    }));

    return (
        <View ref={baseRef} {...props} />
    );
}));

function readTranslateX(element: HTMLElement): number {
    const transform = window.getComputedStyle(element).transform;
    if (!transform || transform === 'none') return 0;

    const matrix3d = transform.match(/^matrix3d\((.+)\)$/);
    if (matrix3d) {
        return Number(matrix3d[1].split(',')[12]) || 0;
    }
    const matrix = transform.match(/^matrix\((.+)\)$/);
    return matrix ? Number(matrix[1].split(',')[4]) || 0 : 0;
}

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
