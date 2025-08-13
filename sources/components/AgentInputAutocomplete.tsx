import * as React from 'react';
import { Pressable } from 'react-native';
import { FloatingOverlay } from './FloatingOverlay';

interface AgentInputAutocompleteProps {
    suggestions: React.ReactElement[];
    selectedIndex?: number;
    onSelect: (index: number) => void;
    itemHeight: number;
}

export const AgentInputAutocomplete = React.memo((props: AgentInputAutocompleteProps) => {
    const { suggestions, selectedIndex = -1, onSelect, itemHeight } = props;

    if (suggestions.length === 0) {
        return null;
    }

    return (
        <FloatingOverlay maxHeight={240} keyboardShouldPersistTaps="handled">
            {suggestions.map((suggestion, index) => (
                <Pressable
                    key={index}
                    onPress={() => onSelect(index)}
                    style={({ pressed }) => ({
                        height: itemHeight,
                        backgroundColor: pressed 
                            ? 'rgba(0, 0, 0, 0.05)' 
                            : selectedIndex === index 
                                ? 'rgba(0, 122, 255, 0.1)'
                                : 'transparent',
                        borderLeftWidth: 3,
                        borderLeftColor: selectedIndex === index ? '#007AFF' : 'transparent',
                    })}
                >
                    {suggestion}
                </Pressable>
            ))}
        </FloatingOverlay>
    );
});