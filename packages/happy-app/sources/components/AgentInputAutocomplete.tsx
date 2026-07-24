import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';
import { AnimatedPopup, LocalBlurHalo } from './AnimatedOverlay';

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

    const suggestionsList = (
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
    );

    // The desktop dropdown deliberately remains the old static popover.
    if (Platform.OS === 'web') {
        return (
            <View style={[styles.container, { maxHeight: MAX_HEIGHT }]}>
                {suggestionsList}
            </View>
        );
    }

    return (
        <AnimatedPopup style={{ maxHeight: MAX_HEIGHT }}>
            <LocalBlurHalo borderRadius={24} />
            <MobileGlassSurface
                enabled
                nativeEffect
                intensity={88}
                glassEffectStyle="regular"
                tintColor={theme.colors.glass.overlayTint}
                style={[styles.container, { maxHeight: MAX_HEIGHT }]}
            >
                {suggestionsList}
            </MobileGlassSurface>
        </AnimatedPopup>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderRadius: Platform.select({ web: 12, default: 24 }),
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: Platform.select({ web: theme.colors.modal.border, default: theme.colors.glass.border }),
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: theme.colors.glass.shadow }),
        shadowOffset: { width: 0, height: Platform.select({ web: 2, default: 16 }) },
        shadowRadius: Platform.select({ web: 3.84, default: 36 }),
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 1 }),
        elevation: 14,
    },
}));
