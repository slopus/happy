import React from 'react';
import { View, Text } from 'react-native';
import { Typography } from '@/constants/Typography';

interface MachineStatusBadgeProps {
    isOnline: boolean;
    size?: 'small' | 'normal';
}

export const MachineStatusBadge = React.memo(({ 
    isOnline, 
    size = 'normal' 
}: MachineStatusBadgeProps) => {
    const isSmall = size === 'small';
    
    return (
        <View style={{ 
            paddingHorizontal: isSmall ? 8 : 12,
            paddingVertical: isSmall ? 4 : 6,
            borderRadius: isSmall ? 10 : 12,
            backgroundColor: isOnline ? '#E8F5E9' : '#F5F5F5'
        }}>
            <Text style={[Typography.default('semiBold'), { 
                fontSize: isSmall ? 11 : 12, 
                color: isOnline ? '#2E7D32' : '#757575'
            }]}>
                {isOnline ? 'ONLINE' : 'OFFLINE'}
            </Text>
        </View>
    );
});

MachineStatusBadge.displayName = 'MachineStatusBadge';