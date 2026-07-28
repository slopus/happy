import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    /** Keep the composer as an overlay while the chat scrolls beneath it. */
    floatingDock?: boolean;
    /** Measured visual inset that the inverted chat list reserves at its bottom. */
    onDockInsetChange?: (inset: number) => void;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    input,
    content,
    placeholder,
    floatingDock = false,
    onDockInsetChange,
}) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const height = useReanimatedKeyboardAnimation();
    const headerHeight = useHeaderHeight();
    const animatedPadding = useSharedValue(0);
    const [dockHeight, setDockHeight] = React.useState(0);

    const handleDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setDockHeight((currentHeight) => (
            Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
        ));
    }, []);

    React.useEffect(() => {
        onDockInsetChange?.(floatingDock ? dockHeight : 0);
    }, [dockHeight, floatingDock, onDockInsetChange]);

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

    if (floatingDock) {
        return (
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView
                        style={[
                            {
                                position: 'absolute',
                                top: safeArea.top + headerHeight,
                                left: 0,
                                right: 0,
                                bottom: dockHeight,
                            },
                            animatePlaceholderdStyle,
                        ]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
                {dockHeight > 0 && (
                    <Animated.View
                        pointerEvents="none"
                        style={[
                            {
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: 0,
                                height: dockHeight + 28,
                                zIndex: 1,
                            },
                            animatedInputStyle,
                        ]}
                    >
                        <LinearGradient
                            colors={theme.dark
                                ? ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.20)', 'rgba(0, 0, 0, 0.66)']
                                : ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.74)']}
                            locations={[0, 0.42, 1]}
                            start={{ x: 0.5, y: 0 }}
                            end={{ x: 0.5, y: 1 }}
                            style={{ flex: 1 }}
                        />
                    </Animated.View>
                )}
                <Animated.View
                    onLayout={handleDockLayout}
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: 2,
                        },
                        animatedInputStyle,
                    ]}
                >
                    {input}
                </Animated.View>
            </View>
        );
    }

    return (
        <View style={{ flexBasis:0, flexGrow:1 }}>
            <View style={{ flexBasis:0, flexGrow:1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView 
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }, animatePlaceholderdStyle]}
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

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });
