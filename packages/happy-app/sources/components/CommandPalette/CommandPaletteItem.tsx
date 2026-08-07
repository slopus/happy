import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform, type StyleProp, type TextStyle } from 'react-native';
import { Command, getCommandPaletteOptionId } from './types';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { multiplyColorOpacity } from '@/utils/colorOpacity';

interface CommandPaletteItemProps {
    command: Command;
    searchQuery?: string;
    quickSelectNumber?: number;
    isSelected: boolean;
    onPress: () => void;
    onHover?: () => void;
}

export interface HighlightedTextSegment {
    text: string;
    matched: boolean;
}

export function splitHighlightedText(text: string, query: string): HighlightedTextSegment[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
        return [{ text, matched: false }];
    }

    const normalizedText = text.toLocaleLowerCase();
    const segments: HighlightedTextSegment[] = [];
    let cursor = 0;
    let matchIndex = normalizedText.indexOf(normalizedQuery, cursor);

    while (matchIndex !== -1) {
        if (matchIndex > cursor) {
            segments.push({ text: text.slice(cursor, matchIndex), matched: false });
        }
        const matchEnd = matchIndex + normalizedQuery.length;
        segments.push({ text: text.slice(matchIndex, matchEnd), matched: true });
        cursor = matchEnd;
        matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
    }

    if (cursor < text.length) {
        segments.push({ text: text.slice(cursor), matched: false });
    }

    return segments.length > 0 ? segments : [{ text, matched: false }];
}

function HighlightedText({
    text,
    query,
    style,
    highlightColor,
    numberOfLines,
}: {
    text: string;
    query: string;
    style: StyleProp<TextStyle>;
    highlightColor: string;
    numberOfLines?: number;
}) {
    return (
        <Text style={style} numberOfLines={numberOfLines}>
            {splitHighlightedText(text, query).map((segment, index) => (
                <Text
                    key={`${index}-${segment.text}`}
                    testID={segment.matched ? 'command-palette-match' : undefined}
                    style={segment.matched ? [styles.match, { color: highlightColor }] : undefined}
                >
                    {segment.text}
                </Text>
            ))}
        </Text>
    );
}

export function CommandPaletteItem({
    command,
    searchQuery = '',
    quickSelectNumber,
    isSelected,
    onPress,
    onHover,
}: CommandPaletteItemProps) {
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
        testID: `command-palette-item-${command.id}`,
        style: ({ pressed }: any) => [
            styles.container,
            isSelected && {
                backgroundColor: multiplyColorOpacity(theme.colors.accent, 0.08),
                borderColor: multiplyColorOpacity(theme.colors.accent, 0.22),
            },
            isHovered && !isSelected && { backgroundColor: theme.colors.surfaceHigh },
            pressed && Platform.OS === 'web' && {
                backgroundColor: multiplyColorOpacity(theme.colors.accent, 0.12),
            },
        ],
        onPress,
        nativeID: getCommandPaletteOptionId(command.id),
        role: 'option',
        'aria-selected': isSelected,
        accessibilityLabel: [
            command.title,
            command.subtitle,
            ...(command.metadata?.map((item) => item.text) ?? []),
        ].filter(Boolean).join(', '),
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
                    <View
                        style={[
                            styles.iconContainer,
                            {
                                backgroundColor: isSelected
                                    ? multiplyColorOpacity(theme.colors.accent, 0.1)
                                    : theme.colors.surfaceHigh,
                            },
                        ]}
                    >
                        <Ionicons 
                            name={command.icon as any} 
                            size={18}
                            color={isSelected ? theme.colors.accent : theme.colors.textSecondary}
                        />
                    </View>
                )}
                <View style={styles.textContainer}>
                    <HighlightedText
                        text={command.title}
                        query={searchQuery}
                        style={[styles.title, Typography.default('semiBold'), { color: theme.colors.text }]}
                        highlightColor={theme.colors.accent}
                        numberOfLines={1}
                    />
                    {command.subtitle && (
                        <HighlightedText
                            text={command.subtitle}
                            query={searchQuery}
                            style={[styles.subtitle, Typography.default(), { color: theme.colors.textSecondary }]}
                            highlightColor={theme.colors.accent}
                            numberOfLines={1}
                        />
                    )}
                    {command.metadata && command.metadata.length > 0 && (
                        <View style={styles.metadataRow}>
                            {command.metadata.map((item, index) => (
                                <View key={`${item.icon}-${item.text}-${index}`} style={styles.metadataItem}>
                                    <Ionicons name={item.icon as any} size={12} color={theme.colors.textSecondary} />
                                    <HighlightedText
                                        text={item.text}
                                        query={searchQuery}
                                        style={[styles.metadataText, Typography.default(), { color: theme.colors.textSecondary }]}
                                        highlightColor={theme.colors.accent}
                                        numberOfLines={1}
                                    />
                                </View>
                            ))}
                        </View>
                    )}
                </View>
                {quickSelectNumber !== undefined && (
                    <View
                        style={[
                            styles.shortcutContainer,
                            { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
                        ]}
                    >
                        <Text style={[styles.shortcut, Typography.mono(), { color: theme.colors.textSecondary }]}>
                            {`Alt+${quickSelectNumber}`}
                        </Text>
                    </View>
                )}
                {command.shortcut && (
                    <View
                        style={[
                            styles.shortcutContainer,
                            { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
                        ]}
                    >
                        <Text style={[styles.shortcut, Typography.mono(), { color: theme.colors.textSecondary }]}>
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
        minHeight: 48,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: 'transparent',
        marginHorizontal: 8,
        marginVertical: 1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    iconContainer: {
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
    },
    textContainer: {
        flex: 1,
        marginRight: 10,
    },
    title: {
        fontSize: 14,
        lineHeight: 19,
        marginBottom: 1,
        letterSpacing: -0.1,
    },
    subtitle: {
        fontSize: 12,
        lineHeight: 16,
    },
    metadataRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        marginTop: 4,
    },
    metadataItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
    },
    metadataText: {
        flexShrink: 1,
        fontSize: 11,
        letterSpacing: -0.1,
    },
    match: {
        fontWeight: '600',
    },
    shortcutContainer: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: StyleSheet.hairlineWidth,
        marginLeft: 5,
    },
    shortcut: {
        fontSize: 10,
        lineHeight: 14,
        fontWeight: '500',
    },
});
