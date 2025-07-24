import React from 'react';
import { View } from 'react-native';
import { Text } from '../StyledText';
import { StatusBadge, ToolState } from './StatusBadge';

interface ToolHeaderProps {
    icon?: string;
    title: string;
    state: ToolState;
    className?: string;
}

export function ToolHeader({ 
    icon, 
    title, 
    state,
    className = '' 
}: ToolHeaderProps) {
    return (
        <View className={`flex-row justify-between items-center mb-4 ${className}`}>
            <Text className="text-lg font-semibold text-gray-900">
                {icon && `${icon} `}{title}
            </Text>
            <StatusBadge state={state} />
        </View>
    );
}