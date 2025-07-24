import React from 'react';
import { View } from 'react-native';

interface DividerLineProps {
    indent?: number;
    color?: string;
    className?: string;
}

export function DividerLine({ 
    indent = 0, 
    color = 'border-gray-200',
    className = '' 
}: DividerLineProps) {
    return (
        <View className="flex-row">
            {indent > 0 && <View style={{ width: indent }} />}
            <View className={`flex-1 border-b ${color} ${className}`} />
        </View>
    );
}