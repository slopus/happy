import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useKeyboardState } from 'react-native-keyboard-controller';
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
    const state = useKeyboardState();
    return (
        <View style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1, minHeight: 0, paddingBottom: state.isVisible ? Math.max(0, state.height - safeArea.bottom) : 0 }}>
            <View style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
                {content && (
                    <View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={[{ position: 'absolute', top: conversationFirst ? 0 : safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }]}
                        testID="agent-placeholder-scroll"
                        contentContainerStyle={conversationFirst ? { alignItems: 'stretch', flexGrow: 1 } : { alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
            </View>
            <View>
                {!state.isVisible && inputAccessory}
                {input}
            </View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });