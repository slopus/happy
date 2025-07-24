import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '../StyledText';

interface SearchResultBlockProps {
    content: string;
    maxHeight?: number;
    showLineNumbers?: boolean;
    className?: string;
}

export function SearchResultBlock({ 
    content, 
    maxHeight = 400,
    showLineNumbers = false,
    className = '' 
}: SearchResultBlockProps) {
    return (
        <View className={`bg-gray-50 rounded-lg p-3 ${className}`}>
            <ScrollView 
                style={{ maxHeight }}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
            >
                <Text 
                    className="text-sm font-mono text-gray-800" 
                    selectable={true}
                >
                    {content}
                </Text>
            </ScrollView>
        </View>
    );
}