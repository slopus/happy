import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { Platform, ViewStyle, KeyboardAvoidingView as RNKeyboardAvoidingView, View, Keyboard } from 'react-native';
import { KeyboardAvoidingView as KCKeyboardAvoidingView, useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AgentContentViewProps {
    children: React.ReactNode;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ children }) => {

    // Use keyboard-controller for iOS, native for Android
    if (Platform.OS === 'ios') {
        return (
            <KCKeyboardAvoidingView
                style={[{ flex: 1 }]}
                behavior="translate-with-padding"
                keyboardVerticalOffset={0}
            >
                {children}
            </KCKeyboardAvoidingView>
        );
    }

    // Use native KeyboardAvoidingView for Android
    return (
        <FallbackKeyboardAvoidingView>
            {children}
        </FallbackKeyboardAvoidingView>
    );
});

const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
    children,
}) => {
    const safeArea = useSafeAreaInsets();
    const height = useReanimatedKeyboardAnimation();
    const animatedStyle = useAnimatedStyle(() => ({
        paddingTop: height.progress.value === 1 ? height.height.value : 0,
        transform: [{ translateY: height.height.value + safeArea.bottom * height.progress.value }]
    }), [safeArea.bottom]);
    return (
        <Animated.View
            style={[{ flex: 1 }, animatedStyle]}
        >
            {children}
        </Animated.View>
    );
});