import React from 'react';
import { View, Text } from 'react-native';
import { Command } from './types';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Typography } from '@/constants/Typography';

interface CommandPaletteItemProps {
    command: Command;
    isSelected: boolean;
    onPress: () => void;
    onHover?: () => void;
}

export function CommandPaletteItem({ command, isSelected, onPress, onHover }: CommandPaletteItemProps) {
    const { theme } = useUnistyles();

    return (
        <SelectableRow
            variant="selectable"
            selected={isSelected}
            onPress={onPress}
            onHover={onHover}
            left={command.icon ? (
                <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(0, 0, 0, 0.04)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                        name={command.icon as any}
                        size={20}
                        color={isSelected ? '#007AFF' : '#666'}
                    />
                </View>
            ) : null}
            title={command.title}
            subtitle={command.subtitle ?? undefined}
            right={command.shortcut ? (
                <View style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(0, 0, 0, 0.04)', borderRadius: 6 }}>
                    <Text style={{ ...Typography.mono(), fontSize: 12, color: '#666', fontWeight: '500' }}>
                        {command.shortcut}
                    </Text>
                </View>
            ) : null}
        />
    );
}
