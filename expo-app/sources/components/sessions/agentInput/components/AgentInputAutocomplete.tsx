import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FloatingOverlay } from '@/components/FloatingOverlay';

interface AgentInputAutocompleteProps {
    suggestions: React.ReactElement[];
    selectedIndex?: number;
    onSelect: (index: number) => void;
    itemHeight: number;
    maxHeight?: number;
}

export const AgentInputAutocomplete = React.memo((props: AgentInputAutocompleteProps) => {
    const { suggestions, selectedIndex = -1, onSelect, itemHeight, maxHeight = 240 } = props;
    const { theme } = useUnistyles();

    if (suggestions.length === 0) {
        return null;
    }

    return (
        <FloatingOverlay maxHeight={maxHeight} keyboardShouldPersistTaps="handled">
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
        </FloatingOverlay>
    );
});
