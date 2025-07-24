import React, { useMemo } from 'react';
import { View, ScrollView, Text, ViewStyle } from 'react-native';
import { useColorScheme } from '@/components/useColorScheme';

interface FileViewProps {
    content: string;
    startLine?: number;  // Optional starting line number (enables line numbering)
    showLineNumbers?: boolean;
    wrapLines?: boolean;
    fontScaleX?: number;
    className?: string;
    style?: ViewStyle;
    title?: string;
}

// Define colors inline
const COLORS = {
    light: {
        background: '#FFFFFF',
        lineNumberBg: '#F9FAFB',
        lineNumberText: '#6B7280',
        lineNumberBorder: '#E5E7EB',
        text: '#111827',
        selectedLineBg: '#FEF3C7',
        leadingSpaceDot: '#E8E8E8',
    },
    dark: {
        background: '#1F2937',
        lineNumberBg: '#111827',
        lineNumberText: '#9CA3AF',
        lineNumberBorder: '#374151',
        text: '#F9FAFB',
        selectedLineBg: '#451A03',
        leadingSpaceDot: '#2A2A2A',
    }
};

export function FileView({
    content,
    startLine,
    showLineNumbers = true,
    wrapLines = true,
    fontScaleX = 1,
    className,
    style,
    title
}: FileViewProps) {
    const colorScheme = useColorScheme();
    const colors = COLORS[colorScheme ?? 'light'];

    // Split content into lines
    const lines = useMemo(() => {
        if (!content) return [];
        return content.split('\n');
    }, [content]);

    // Calculate line numbers
    const lineNumbers = useMemo(() => {
        if (!startLine || !showLineNumbers) return null;
        return lines.map((_, index) => startLine + index);
    }, [lines, startLine, showLineNumbers]);

    // Calculate max line number for width
    const maxLineNumber = useMemo(() => {
        if (!lineNumbers) return 0;
        return Math.max(...lineNumbers);
    }, [lineNumbers]);

    // Calculate line number width
    const lineNumberWidth = useMemo(() => {
        if (!showLineNumbers || !lineNumbers) return 0;
        const digits = maxLineNumber.toString().length;
        return Math.max(40, digits * 10 + 16); // Minimum 40px, more space per digit
    }, [maxLineNumber, showLineNumbers, lineNumbers]);

    const renderLine = (line: string, index: number) => {
        // Process leading spaces
        const leadingSpaces = line.match(/^(\s*)/)?.[1] || '';
        const restOfLine = line.slice(leadingSpaces.length);
        const dots = '·'.repeat(leadingSpaces.length);

        return (
            <View
                key={index}
                style={{
                    flexDirection: 'row',
                    minHeight: 20,
                }}
            >
                {showLineNumbers && lineNumbers && (
                    <View
                        style={{
                            width: lineNumberWidth,
                            backgroundColor: colors.lineNumberBg,
                            borderRightWidth: 1,
                            borderRightColor: colors.lineNumberBorder,
                            paddingRight: 8,
                            paddingLeft: 4,
                            alignItems: 'flex-end',
                            justifyContent: 'center',
                        }}
                    >
                        <Text
                            style={{
                                fontFamily: 'IBMPlexMono_400Regular',
                                fontSize: 12,
                                color: colors.lineNumberText,
                                lineHeight: 20,
                            }}
                            numberOfLines={1}
                        >
                            {lineNumbers[index]}
                        </Text>
                    </View>
                )}
                <View
                    style={{
                        flex: 1,
                        paddingLeft: 12,
                        paddingRight: 20,
                        paddingVertical: 0,
                    }}
                >
                    <Text
                        style={{
                            fontFamily: 'IBMPlexMono_400Regular',
                            fontSize: 13,
                            lineHeight: 20,
                            transform: [{ scaleX: fontScaleX }],
                            color: colors.text,
                        }}
                        numberOfLines={wrapLines ? undefined : 1}
                    >
                        {leadingSpaces.length > 0 && (
                            <Text style={{ color: colors.leadingSpaceDot }}>{dots}</Text>
                        )}
                        {restOfLine}
                    </Text>
                </View>
            </View>
        );
    };

    const contentElement = (
        <View style={{ backgroundColor: colors.background }}>
            {lines.map((line, index) => renderLine(line, index))}
        </View>
    );

    return (
        <View style={[{ flex: 1, backgroundColor: colors.background }, style]} className={className}>
            {title && (
                <View
                    style={{
                        backgroundColor: colors.lineNumberBg,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.lineNumberBorder,
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: colors.text,
                        }}
                    >
                        {title}
                    </Text>
                </View>
            )}
            
            {wrapLines ? (
                contentElement
            ) : (
                <ScrollView
                    horizontal={true}
                    showsHorizontalScrollIndicator={true}
                    showsVerticalScrollIndicator={false}
                    contentOffset={showLineNumbers && lineNumbers ? { x: lineNumberWidth, y: 0 } : undefined}
                >
                    {contentElement}
                </ScrollView>
            )}
        </View>
    );
}