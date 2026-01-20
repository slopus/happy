import React from 'react';
import { Pressable, Keyboard } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

interface PlaceholderContainerViewProps {
    children: React.ReactNode;
    style?: any;
    contentContainerStyle?: any;
}

export const PlaceholderContainerView: React.FC<PlaceholderContainerViewProps> = ({
    children,
    style,
    contentContainerStyle
}) => {
    const { height, progress } = useReanimatedKeyboardAnimation();

    const animatedStyle = useAnimatedStyle(() => {
        // Shift content up by half the keyboard height when keyboard is visible
        const translateY = height.value * progress.value * 0.5;
        
        return {
            transform: [{ translateY }],
        };
    }, []);

    return (
        <Animated.View style={[{ flex: 1 }, style]}>
            <Pressable
                style={[
                    {
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                    },
                    contentContainerStyle
                ]}
                onPress={() => Keyboard.dismiss()}
            >
                <Animated.View style={animatedStyle}>
                    {children}
                </Animated.View>
            </Pressable>
        </Animated.View>
    );
};