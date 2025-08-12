import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Command } from './types';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';

interface CommandPaletteItemProps {
    command: Command;
    isSelected: boolean;
    onPress: () => void;
    onHover?: () => void;
}

export function CommandPaletteItem({ command, isSelected, onPress, onHover }: CommandPaletteItemProps) {
    const [isHovered, setIsHovered] = React.useState(false);
    
    const handleMouseEnter = React.useCallback(() => {
        if (Platform.OS === 'web') {
            setIsHovered(true);
            onHover?.();
        }
    }, [onHover]);
    
    const handleMouseLeave = React.useCallback(() => {
        if (Platform.OS === 'web') {
            setIsHovered(false);
        }
    }, []);
    
    const pressableProps: any = {
        style: ({ pressed }: any) => [
            styles.container,
            isSelected && styles.selected,
            isHovered && !isSelected && styles.hovered,
            pressed && Platform.OS === 'web' && styles.pressed
        ],
        onPress,
    };
    
    // Add mouse events only on web
    if (Platform.OS === 'web') {
        pressableProps.onMouseEnter = handleMouseEnter;
        pressableProps.onMouseLeave = handleMouseLeave;
    }
    
    return (
        <Pressable {...pressableProps}>
            <View style={styles.content}>
                {command.icon && (
                    <View style={styles.iconContainer}>
                        <Ionicons 
                            name={command.icon as any} 
                            size={20} 
                            color={isSelected ? '#007AFF' : '#666'} 
                        />
                    </View>
                )}
                <View style={styles.textContainer}>
                    <Text style={[styles.title, Typography.default()]}>
                        {command.title}
                    </Text>
                    {command.subtitle && (
                        <Text style={[styles.subtitle, Typography.default()]}>
                            {command.subtitle}
                        </Text>
                    )}
                </View>
                {command.shortcut && (
                    <View style={styles.shortcutContainer}>
                        <Text style={[styles.shortcut, Typography.mono()]}>
                            {command.shortcut}
                        </Text>
                    </View>
                )}
            </View>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 24,
        paddingVertical: 12,
        backgroundColor: 'transparent',
        marginHorizontal: 8,
        marginVertical: 2,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: 'transparent',
    },
    selected: {
        backgroundColor: '#F0F7FF',
        borderColor: '#007AFF20',
    },
    pressed: {
        backgroundColor: '#F5F5F5',
    },
    hovered: {
        backgroundColor: '#F8F8F8',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    iconContainer: {
        width: 32,
        height: 32,
        borderRadius: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.04)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    textContainer: {
        flex: 1,
        marginRight: 12,
    },
    title: {
        fontSize: 15,
        color: '#000',
        marginBottom: 2,
        letterSpacing: -0.2,
    },
    subtitle: {
        fontSize: 13,
        color: '#666',
        letterSpacing: -0.1,
    },
    shortcutContainer: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: 'rgba(0, 0, 0, 0.04)',
        borderRadius: 6,
    },
    shortcut: {
        fontSize: 12,
        color: '#666',
        fontWeight: '500',
    },
});