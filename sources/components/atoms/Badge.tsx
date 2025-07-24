import React from 'react';
import { View } from 'react-native';
import { Text } from '../StyledText';

type BadgeVariant = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info';
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps {
    children: React.ReactNode;
    variant?: BadgeVariant;
    size?: BadgeSize;
    className?: string;
}

const VARIANT_STYLES: Record<BadgeVariant, { bg: string; text: string }> = {
    default: { bg: 'bg-surface-variant', text: 'text-on-surface-variant' },
    primary: { bg: 'bg-primary-container', text: 'text-on-primary-container' },
    secondary: { bg: 'bg-accent-container', text: 'text-on-accent-container' },
    success: { bg: 'bg-success-container', text: 'text-success' },
    warning: { bg: 'bg-warning-container', text: 'text-warning' },
    danger: { bg: 'bg-error-container', text: 'text-error' },
    info: { bg: 'bg-info-container', text: 'text-info' }
};

const SIZE_STYLES: Record<BadgeSize, { padding: string; text: string }> = {
    sm: { padding: 'px-1.5 py-0.5', text: 'text-xs' },
    md: { padding: 'px-2 py-1', text: 'text-sm' },
    lg: { padding: 'px-3 py-1.5', text: 'text-base' }
};

export function Badge({ 
    children, 
    variant = 'default',
    size = 'md',
    className = '' 
}: BadgeProps) {
    const variantStyle = VARIANT_STYLES[variant];
    const sizeStyle = SIZE_STYLES[size];
    
    return (
        <View className={`rounded-md self-start ${variantStyle.bg} ${sizeStyle.padding} ${className}`}>
            <Text className={`font-bold ${variantStyle.text} ${sizeStyle.text}`}>
                {children}
            </Text>
        </View>
    );
}