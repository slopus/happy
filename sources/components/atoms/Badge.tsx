import React from 'react';
import { View, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { Text } from '../StyledText';

type BadgeVariant = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info';
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps {
    children: React.ReactNode;
    variant?: BadgeVariant;
    size?: BadgeSize;
    style?: ViewStyle;
}

const VARIANT_STYLES: Record<BadgeVariant, { backgroundColor: string; color: string }> = {
    default: { backgroundColor: '#F5F5F5', color: '#666666' },
    primary: { backgroundColor: '#E3F2FD', color: '#1976D2' },
    secondary: { backgroundColor: '#F3E5F5', color: '#7B1FA2' },
    success: { backgroundColor: '#E8F5E8', color: '#2E7D32' },
    warning: { backgroundColor: '#FFF3E0', color: '#F57C00' },
    danger: { backgroundColor: '#FFEBEE', color: '#D32F2F' },
    info: { backgroundColor: '#E1F5FE', color: '#0288D1' }
};

const SIZE_STYLES: Record<BadgeSize, { paddingHorizontal: number; paddingVertical: number; fontSize: number }> = {
    sm: { paddingHorizontal: 6, paddingVertical: 2, fontSize: 12 },
    md: { paddingHorizontal: 8, paddingVertical: 4, fontSize: 14 },
    lg: { paddingHorizontal: 12, paddingVertical: 6, fontSize: 16 }
};

const styles = StyleSheet.create({
    badge: {
        borderRadius: 6,
        alignSelf: 'flex-start',
    },
    text: {
        fontWeight: 'bold',
    },
});

export function Badge({ 
    children, 
    variant = 'default',
    size = 'md',
    style 
}: BadgeProps) {
    const variantStyle = VARIANT_STYLES[variant];
    const sizeStyle = SIZE_STYLES[size];
    
    return (
        <View style={[
            styles.badge,
            {
                backgroundColor: variantStyle.backgroundColor,
                paddingHorizontal: sizeStyle.paddingHorizontal,
                paddingVertical: sizeStyle.paddingVertical,
            },
            style
        ]}>
            <Text style={[
                styles.text,
                {
                    color: variantStyle.color,
                    fontSize: sizeStyle.fontSize,
                }
            ]}>
                {children}
            </Text>
        </View>
    );
}