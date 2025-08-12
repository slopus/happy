import * as React from 'react';
import { Pressable, ScrollView, View, Platform } from 'react-native';

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

    // Container styles with shadow
    const containerStyle = {
        backgroundColor: 'white',
        borderRadius: 12,
        maxHeight: 240,
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: -2 },
                shadowOpacity: 0.1,
                shadowRadius: 8,
            },
            android: {
                elevation: 4,
            },
            default: {
                boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.1)',
            },
        }),
        borderWidth: Platform.OS === 'web' ? 0 : 0.5,
        borderColor: 'rgba(0, 0, 0, 0.1)',
        overflow: 'hidden' as const,
    };

    return (
        <View style={containerStyle}>
            <ScrollView
                style={{ maxHeight: 240 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
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
            </ScrollView>
        </View>
    );
});