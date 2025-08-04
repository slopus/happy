import * as React from 'react';
import { AutocompleteResult } from '@/hooks/useAutocomplete';
import { Pressable, ScrollView, Text, View } from 'react-native';

export const AutoCompleteView = React.memo((props: {
    results: AutocompleteResult[],
    onSelect: (result: AutocompleteResult) => void,
}) => {
    return (
        <ScrollView style={{ maxHeight: 100, backgroundColor: 'white' }}>
            {props.results.map((result) => (
                <Pressable key={result.text} onPress={() => props.onSelect(result)} style={{ paddingHorizontal: 32 }}>
                    <Text>{result.text}</Text>
                </Pressable>
            ))}
        </ScrollView>
    );
});