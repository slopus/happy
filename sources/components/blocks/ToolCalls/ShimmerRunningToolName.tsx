import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import Animated, { useSharedValue, withRepeat, withTiming, Easing, useAnimatedStyle } from 'react-native-reanimated';

export function ShimmerText({ children }: { children: string; }) {
  const shimmerPosition = useSharedValue(-1);
  const opacityPhase = useSharedValue(0);

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, {
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      false
    );

    opacityPhase.value = withRepeat(
      withTiming(2 * Math.PI, {
        duration: 1200,
        easing: Easing.linear,
      }),
      -1,
      false
    );
  }, [shimmerPosition, opacityPhase]);

  // Slide across the text while pulsing the opacity to hide the edges of the loop restart
  const shimmerStyle = useAnimatedStyle(() => {
    const translateX = shimmerPosition.value * 80;
    const opacity = 0.4 + 0.2 * Math.sin(opacityPhase.value);
    return {
      transform: [{ translateX }],
      opacity,
    };
  });

  return (
    <View className="relative overflow-hidden">
      {/* Base text */}
      <Text className="text-sm text-neutral-500 font-bold" style={{ opacity: 0.7 }}>
        {children}
      </Text>

      {/* Sliding shimmer overlay */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: 0,
            left: -20,
            width: 40,
            height: '100%',
            backgroundColor: 'rgba(255, 255, 255, 0.8)',
            //backgroundColor: 'rgb(255, 0,0)',
            borderRadius: 2,
          },
          shimmerStyle,
        ]} />
    </View>
  );
}
