import React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
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
    const { theme } = useUnistyles();
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
                            color={isSelected ? theme.colors.blue.standard : theme.colors.textSecondary}
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

const styles = StyleSheet.create((theme) => ({
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
        backgroundColor: theme.colors.blue.bg,
        borderColor: theme.colors.divider,
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    hovered: {
        backgroundColor: theme.colors.surfaceHigh,
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
        backgroundColor: theme.colors.surfaceHigh,
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
        color: theme.colors.text,
        marginBottom: 2,
        letterSpacing: -0.2,
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        letterSpacing: -0.1,
    },
    shortcutContainer: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
    },
    shortcut: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
}));
