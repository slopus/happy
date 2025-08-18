import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { Text } from '../StyledText';

interface InfoBoxProps {
    title?: string;
    variant?: 'info' | 'warning' | 'error' | 'success';
    children: React.ReactNode;
    style?: ViewStyle;
}

const VARIANT_COLORS = {
    info: {
        backgroundColor: '#E3F2FD', // light blue
        borderColor: '#2196F3', // blue
        titleColor: '#1976D2', // dark blue
    },
    warning: {
        backgroundColor: '#FFF8E1', // light amber
        borderColor: '#FF9800', // orange
        titleColor: '#F57C00', // dark orange
    },
    error: {
        backgroundColor: '#FFEBEE', // light red
        borderColor: '#F44336', // red
        titleColor: '#D32F2F', // dark red
    },
    success: {
        backgroundColor: '#E8F5E8', // light green
        borderColor: '#4CAF50', // green
        titleColor: '#388E3C', // dark green
    }
};

export function InfoBox({ 
    title, 
    variant = 'info',
    children,
    style 
}: InfoBoxProps) {
    const variantColors = VARIANT_COLORS[variant];
    
    return (
        <View style={[
            styles.container, 
            { 
                backgroundColor: variantColors.backgroundColor,
                borderColor: variantColors.borderColor 
            },
            style
        ]}>
            {title && (
                <Text style={[
                    styles.title,
                    { color: variantColors.titleColor }
                ]}>
                    {title}
                </Text>
            )}
            <View>
                {children}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderRadius: 8,
        padding: 12,
        borderWidth: 1,
    },
    title: {
        fontSize: 14,
        fontWeight: '500',
        marginBottom: 8,
    },
});