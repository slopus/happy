import * as React from 'react';
import { Platform, ViewStyle, KeyboardAvoidingView as RNKeyboardAvoidingView, View, Keyboard } from 'react-native';
import { KeyboardAvoidingView as KCKeyboardAvoidingView, useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AgentContentViewProps {
    children: React.ReactNode;
    style?: ViewStyle;
    keyboardVerticalOffset?: number;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    children,
    style,
    keyboardVerticalOffset
}) => {
    const safeArea = useSafeAreaInsets();

    // Default offset includes safe area top + standard header height
    const defaultOffset = Platform.OS === 'ios'
        ? safeArea.top + 44
        : safeArea.top + 56;

    // Use keyboard-controller for iOS, native for Android
    if (Platform.OS === 'ios') {
        return (
            <KCKeyboardAvoidingView
                style={[{ flex: 1 }, style]}
                behavior="translate-with-padding"
                keyboardVerticalOffset={keyboardVerticalOffset ?? defaultOffset}
            >
                {children}
            </KCKeyboardAvoidingView>
        );
    }

    // Use native KeyboardAvoidingView for Android
    return (
        <FallbackKeyboardAvoidingView
            style={style}
            keyboardVerticalOffset={keyboardVerticalOffset}
        >
            {children}
        </FallbackKeyboardAvoidingView>
    );
});

const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
    children,
    style,
    keyboardVerticalOffset
}) => {
    const safeArea = useSafeAreaInsets();
    const height = useReanimatedKeyboardAnimation();
    const animatedStyle = useAnimatedStyle(() => ({
        paddingTop: height.progress.value === 1 ? height.height.value : 0,
        transform: [{ translateY: height.height.value - safeArea.bottom * (1 - height.progress.value) }]
    }), [safeArea.bottom]);
    return (
        <Animated.View
            style={[{ flex: 1 }, style, animatedStyle]}
        >
            {children}
        </Animated.View>
    );
});