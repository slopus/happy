import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { ChatComposerOverlayContext } from './ChatComposerOverlayContext';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    inputAccessory?: React.ReactNode | null;
    conversationFirst?: boolean;
}

/** The transcript owns the whole viewport; only its tail reserves composer space. */
export const AgentContentView = React.memo(function AgentContentView({ input, content, placeholder,
    inputAccessory, conversationFirst = false }: AgentContentViewProps) {
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const [inputHeight, setInputHeight] = React.useState(0);
    const measureInput = React.useCallback((event: LayoutChangeEvent) => {
        setInputHeight(Math.ceil(event.nativeEvent.layout.height));
    }, []);
    const hasInput = Boolean(input || inputAccessory);
    const inset = hasInput ? inputHeight : 0;

    return <View style={styles.container}>
        <ChatComposerOverlayContext.Provider value={inset}>
            {content && <View style={styles.content}>{content}</View>}
        </ChatComposerOverlayContext.Provider>
        {placeholder && <ScrollView
            style={[styles.content, { top: conversationFirst ? 0 : safeArea.top + headerHeight }]}
            testID="agent-placeholder-scroll"
            contentContainerStyle={[conversationFirst ? styles.conversationPlaceholder : styles.placeholder,
                { paddingBottom: inset }]}
            keyboardShouldPersistTaps="handled"
            alwaysBounceVertical={false}
        >{placeholder}</ScrollView>}
        {hasInput && <View onLayout={measureInput} pointerEvents="box-none" style={styles.input}
            testID="agent-composer-overlay">
            {inputAccessory}
            {input}
        </View>}
    </View>;
});

const styles = StyleSheet.create(() => ({
    container: { flexBasis: 0, flexGrow: 1, flexShrink: 1, minHeight: 0 },
    content: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 },
    input: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 8, zIndex: 1 },
    placeholder: { alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
    conversationPlaceholder: { alignItems: 'stretch', flexGrow: 1 },
}));
