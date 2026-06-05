import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const MAX_HEIGHT = 320;

interface AgentInputAutocompleteProps {
    suggestions: React.ReactElement[];
    selectedIndex?: number;
    onSelect: (index: number) => void;
    itemHeight: number;
}

// We don't reuse FloatingOverlay here because the dropdown needs a ref on
// its ScrollView so arrow-key navigation can scroll the selected item into
// view when the list exceeds the visible window.
export const AgentInputAutocomplete = React.memo((props: AgentInputAutocompleteProps) => {
    const { suggestions, selectedIndex = -1, onSelect, itemHeight } = props;
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<ScrollView>(null);

    // Keep the selected item within the visible window when the user
    // arrow-keys through suggestions. itemHeight is enough to compute the
    // target since every row has identical height (the dropdown is fixed
    // pitch).
    React.useEffect(() => {
        if (selectedIndex < 0 || !scrollRef.current) return;
        const itemTop = selectedIndex * itemHeight;
        const itemBottom = itemTop + itemHeight;
        const view = scrollRef.current as unknown as {
            scrollTo?: (opts: { y: number; animated?: boolean }) => void;
            getScrollableNode?: () => HTMLDivElement | null;
        };
        // Web RN exposes the underlying div; we can read scrollTop directly
        // for tighter control. Native falls back to scrollTo with a guess.
        const node = view.getScrollableNode?.();
        if (node) {
            const visibleTop = node.scrollTop;
            const visibleBottom = visibleTop + node.clientHeight;
            if (itemTop < visibleTop) {
                node.scrollTop = itemTop;
            } else if (itemBottom > visibleBottom) {
                node.scrollTop = itemBottom - node.clientHeight;
            }
            return;
        }
        view.scrollTo?.({ y: itemTop, animated: false });
    }, [selectedIndex, itemHeight]);

    if (suggestions.length === 0) {
        return null;
    }

    return (
        <View style={[styles.container, { maxHeight: MAX_HEIGHT }]}>
            <ScrollView
                ref={scrollRef}
                style={{ maxHeight: MAX_HEIGHT }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={true}
            >
                {suggestions.map((suggestion, index) => (
                    <Pressable
                        key={index}
                        onPress={() => onSelect(index)}
                        style={({ pressed }) => ({
                            height: itemHeight,
                            backgroundColor: pressed
                                ? theme.colors.surfacePressed
                                : selectedIndex === index
                                    ? theme.colors.surfaceSelected
                                    : 'transparent',
                        })}
                    >
                        {suggestion}
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: Platform.OS === 'web' ? 0 : 0.5,
        borderColor: theme.colors.modal.border,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 3.84,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 5,
    },
}));