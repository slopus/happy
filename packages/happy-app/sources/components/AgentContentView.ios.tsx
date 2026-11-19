import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { View } from 'react-native';
import { useKeyboardHandler, useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    inputAccessory?: React.ReactNode | null;
    conversationFirst?: boolean;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder, inputAccessory, conversationFirst = false }) => {
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const height = useReanimatedKeyboardAnimation();
    const keyboard = useKeyboardState();
    const animatedPadding = useSharedValue(0);
    useKeyboardHandler({
        onEnd(e) {
            'worklet';
            animatedPadding.value = e.progress === 1 ? (-height.height.value - safeArea.bottom) : 0;
        },
        onStart(e) {
            'worklet';
            animatedPadding.value = 0;
        },
    },[safeArea.bottom]);
    const animatedStyle = useAnimatedStyle(() => ({
        paddingTop: animatedPadding.value,
        transform: [{ translateY: height.height.value + safeArea.bottom * height.progress.value }]
    }), [safeArea.bottom]);
    const animatedInputStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: height.height.value + safeArea.bottom * height.progress.value }]
    }), [safeArea.bottom]);
    const animatePlaceholderdStyle = useAnimatedStyle(() => ({
        paddingTop: height.progress.value === 1 ? height.height.value : 0,
        transform: [{ translateY: (height.height.value  + safeArea.bottom * height.progress.value) / 2 }]
    }), [safeArea.bottom]);
    return (
        <View style={{ flexBasis:0, flexGrow:1, flexShrink:1, minHeight:0 }}>
            <View style={{ flexBasis:0, flexGrow:1, flexShrink:1, minHeight:0 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView 
                        style={[{ position: 'absolute', top: conversationFirst ? 0 : safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }, animatePlaceholderdStyle]}
                        contentContainerStyle={conversationFirst ? { alignItems: 'stretch', flexGrow: 1 } : { alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
            </View>
            <Animated.View style={[animatedInputStyle]}>
                {!keyboard.isVisible && inputAccessory}
                {input}
            </Animated.View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });