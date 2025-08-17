import React from 'react';
import { View, Text, Pressable, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from '@/utils/machineUtils';

interface MachineItemProps {
    machine: Machine;
    onPress?: () => void;
    showChevron?: boolean;
    showStatus?: boolean;
    style?: StyleProp<ViewStyle>;
}

export const MachineItem = React.memo(({ 
    machine, 
    onPress, 
    showChevron = false,
    showStatus = true,
    style 
}: MachineItemProps) => {
    const isOnline = isMachineOnline(machine);
    const machineName = machine.metadata?.host || machine.id;
    
    return (
        <Pressable
            style={[{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingVertical: 12,
                backgroundColor: '#fff'
            }, style]}
            onPress={onPress}
            disabled={!onPress}
        >
            <Ionicons 
                name="desktop-outline" 
                size={24} 
                color="#007AFF"
                style={{ marginRight: 12 }}
            />
            
            <Text style={{ 
                fontSize: 15, 
                color: '#000', 
                flex: 1,
                ...Typography.default() 
            }}>
                {machineName}
            </Text>
            
            {showStatus && (
                <View style={{ 
                    flexDirection: 'row', 
                    alignItems: 'center' 
                }}>
                    <View style={{ 
                        width: 8, 
                        height: 8, 
                        borderRadius: 4, 
                        backgroundColor: isOnline ? '#34C759' : '#C7C7CC',
                        marginRight: 4
                    }} />
                    <Text style={[Typography.default(), { 
                        fontSize: 12, 
                        color: isOnline ? '#34C759' : '#8E8E93',
                        marginRight: showChevron ? 8 : 0
                    }]}>
                        {isOnline ? 'online' : 'offline'}
                    </Text>
                </View>
            )}
            
            {showChevron && (
                <Ionicons 
                    name="chevron-forward" 
                    size={20} 
                    color="#C7C7CC" 
                />
            )}
        </Pressable>
    );
});

MachineItem.displayName = 'MachineItem';