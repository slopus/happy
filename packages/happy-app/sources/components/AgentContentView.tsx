import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ScrollView } from 'react-native-gesture-handler';
import { useKeyboardState } from 'react-native-keyboard-controller';
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
    const headerHeight = useHeaderHeight();
    const state = useKeyboardState();
    const keyboardInset = state.isVisible ? Math.max(0, state.height - safeArea.bottom) : 0;
    const [dockHeight, setDockHeight] = React.useState(0);

    const handleDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setDockHeight((currentHeight) => (
            Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
        ));
    }, []);

    React.useEffect(() => {
        onDockInsetChange?.(floatingDock ? dockHeight + keyboardInset + safeArea.bottom : 0);
    }, [dockHeight, floatingDock, keyboardInset, onDockInsetChange, safeArea.bottom]);

    if (floatingDock) {
        return (
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={{
                            position: 'absolute',
                            top: safeArea.top + headerHeight,
                            left: 0,
                            right: 0,
                            bottom: dockHeight + keyboardInset + safeArea.bottom,
                        }}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
                {dockHeight > 0 && (
                    <View
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: keyboardInset,
                            height: dockHeight + safeArea.bottom + 28,
                            zIndex: 1,
                        }}
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
                    </View>
                )}
                <View
                    onLayout={handleDockLayout}
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: keyboardInset + safeArea.bottom,
                        zIndex: 2,
                    }}
                >
                    {input}
                </View>
            </View>
        );
    }

    return (
        <View style={{ flexBasis:0, flexGrow:1, paddingBottom: keyboardInset }}>
            <View style={{ flexBasis:0, flexGrow:1 }}>
                {content && (
                    <View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
            </View>
            <View>
                {input}
            </View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });
