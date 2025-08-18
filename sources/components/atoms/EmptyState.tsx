import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { Text } from '../StyledText';
import { Ionicons } from '@expo/vector-icons';

interface EmptyStateProps {
    icon?: keyof typeof Ionicons.glyphMap;
    title: string;
    description?: string;
    iconSize?: number;
    iconColor?: string;
    style?: ViewStyle;
}

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        paddingVertical: 32,
        paddingHorizontal: 16,
    },
    title: {
        color: '#6B7280',
        fontSize: 18,
        fontWeight: '500',
        marginTop: 16,
        textAlign: 'center',
    },
    description: {
        color: '#9CA3AF',
        fontSize: 14,
        textAlign: 'center',
        marginTop: 8,
        maxWidth: 288, // equivalent to max-w-xs
    },
});

export function EmptyState({ 
    icon = 'cube-outline',
    title,
    description,
    iconSize = 48,
    iconColor = '#9CA3AF',
    style
}: EmptyStateProps) {
    return (
        <View style={[styles.container, style]}>
            <Ionicons name={icon} size={iconSize} color={iconColor} />
            <Text style={styles.title}>
                {title}
            </Text>
            {description && (
                <Text style={styles.description}>
                    {description}
                </Text>
            )}
        </View>
    );
}