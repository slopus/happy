import React from 'react';
import { View, ScrollView, StyleSheet, ViewStyle } from 'react-native';
import { Text } from '../StyledText';

interface SearchResultBlockProps {
    content: string;
    maxHeight?: number;
    showLineNumbers?: boolean;
    style?: ViewStyle;
}

export function SearchResultBlock({ 
    content, 
    maxHeight = 400,
    showLineNumbers = false,
    style 
}: SearchResultBlockProps) {
    return (
        <View style={[styles.container, style]}>
            <ScrollView 
                style={{ maxHeight }}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
            >
                <Text 
                    style={styles.text}
                    selectable={true}
                >
                    {content}
                </Text>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#F9FAFB',
        borderRadius: 8,
        padding: 12,
    },
    text: {
        fontSize: 14,
        fontFamily: 'monospace',
        color: '#1F2937',
    },
});