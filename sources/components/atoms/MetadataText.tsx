import React from 'react';
import { Text } from '../StyledText';
import { TOOL_COMPACT_VIEW_STYLES } from '../blocks/tools/constants';

interface MetadataTextProps {
    children: React.ReactNode;
    color?: string;
    className?: string;
}

export function MetadataText({ 
    children, 
    color = 'text-neutral-500',
    className = '' 
}: MetadataTextProps) {
    return (
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} ${color} font-bold px-1 ${className}`}>
            {children}
        </Text>
    );
}