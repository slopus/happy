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
      const offsets = shakeKeyframes();
      const duration = 300;
      const animations: Animated.CompositeAnimation[] = [];
      for (let i = 0; i < offsets.length; i++) {
        animations.push(Animated.timing(shakeValue, {
          toValue: offsets[i],
          duration: duration / offsets.length,
          useNativeDriver: true,
        }));
      }
      Animated.sequence(animations).start();
    },
  }));
  return (
    <Animated.View ref={baseRef} style={[{ transform: [{ translateX: shakeValue }] }, style]} {...rest} />
  );
}));

function shakeKeyframes(amplitude: number = 3.0, count: number = 4, decay: boolean = false) {
  const keyframes: number[] = [];
  keyframes.push(0);
  for (let i = 0; i < count; i++) {
    const sign = (i % 2 == 0) ? 1.0 : -1.0;
    const multiplier = decay ? (1.0 / (i + 1)) : 1.0;
    keyframes.push(amplitude * sign * multiplier);
  }
  keyframes.push(0);
  return keyframes;
}