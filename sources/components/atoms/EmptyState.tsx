import React from 'react';
import { View } from 'react-native';
import { Text } from '../StyledText';
import { Ionicons } from '@expo/vector-icons';

interface EmptyStateProps {
    icon?: keyof typeof Ionicons.glyphMap;
    title: string;
    description?: string;
    iconSize?: number;
    iconColor?: string;
    className?: string;
}

export function EmptyState({ 
    icon = 'cube-outline',
    title,
    description,
    iconSize = 48,
    iconColor = '#9CA3AF',
    className = ''
}: EmptyStateProps) {
    return (
        <View className={`items-center py-8 px-4 ${className}`}>
            <Ionicons name={icon} size={iconSize} color={iconColor} />
            <Text className="text-gray-500 text-lg font-medium mt-4 text-center">
                {title}
            </Text>
            {description && (
                <Text className="text-gray-400 text-sm text-center mt-2 max-w-xs">
                    {description}
                </Text>
            )}
        </View>
    );
}