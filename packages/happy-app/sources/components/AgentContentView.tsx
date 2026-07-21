import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { View, Platform } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder }) => {
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const keyboard = useReanimatedKeyboardAnimation();
    const animatedPadding = useSharedValue(0);

    useKeyboardHandler({
        onEnd(e) {
            'worklet';
            animatedPadding.value = e.progress === 1 ? (-keyboard.height.value - safeArea.bottom) : 0;
        },
        onStart(e) {
            'worklet';
            animatedPadding.value = 0;
        },
    }, [safeArea.bottom]);

    const animatedStyle = useAnimatedStyle(() => ({
        paddingTop: animatedPadding.value,
        transform: [{ translateY: keyboard.height.value + safeArea.bottom * keyboard.progress.value }],
    }), [safeArea.bottom]);

    const animatedInputStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: keyboard.height.value + safeArea.bottom * keyboard.progress.value }],
    }), [safeArea.bottom]);

    const animatedPlaceholderStyle = useAnimatedStyle(() => ({
        paddingTop: keyboard.progress.value === 1 ? keyboard.height.value : 0,
        transform: [{ translateY: (keyboard.height.value + safeArea.bottom * keyboard.progress.value) / 2 }],
    }), [safeArea.bottom]);

    return (
        <View style={{ flexBasis: 0, flexGrow: 1 }}>
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }, animatedPlaceholderStyle]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
            </View>
            <Animated.View style={[animatedInputStyle]}>
                {input}
            </Animated.View>
        </View>
    );
});
