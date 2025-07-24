import React, { useMemo, useRef, useEffect } from 'react';
import { View, ScrollView, Text, ViewStyle, TextStyle } from 'react-native';
import { useColorScheme } from '@/components/useColorScheme';
import { calculateUnifiedDiff, DiffToken } from '@/components/files/calculateDiff';
import { Typography } from '@/constants/Typography';


interface DiffViewProps {
    oldText: string;
    newText: string;
    contextLines?: number;
    showLineNumbers?: boolean;
    showDiffStats?: boolean;
    oldTitle?: string;
    newTitle?: string;
    className?: string;
    style?: ViewStyle;
    maxHeight?: number;
    wrapLines?: boolean;
    fontScaleX?: number;
}

// Define colors inline - using traditional diff colors
const COLORS = {
    light: {
        surface: '#FFFFFF',
        surfaceVariant: '#F8F8F8',
        onSurface: '#000000',
        onSurfaceVariant: '#666666',
        outline: '#E0E0E0',
        success: '#28A745',
        error: '#DC3545',
        // Traditional diff colors
        addedBg: '#E6FFED',
        addedBorder: '#34D058',
        addedText: '#24292E',
        removedBg: '#FFEEF0',
        removedBorder: '#D73A49',
        removedText: '#24292E',
        contextBg: '#F6F8FA',
        contextText: '#586069',
        lineNumberBg: '#F6F8FA',
        lineNumberText: '#959DA5',
        hunkHeaderBg: '#F1F8FF',
        hunkHeaderText: '#005CC5',
        leadingSpaceDot: '#E8E8E8',
        inlineAddedBg: '#ACFFA6',
        inlineAddedText: '#0A3F0A',
        inlineRemovedBg: '#FFCECB',
        inlineRemovedText: '#5A0A05',
    },
    dark: {
        surface: '#0D1117',
        surfaceVariant: '#161B22',
        onSurface: '#C9D1D9',
        onSurfaceVariant: '#8B949E',
        outline: '#30363D',
        success: '#3FB950',
        error: '#F85149',
        // Traditional diff colors for dark mode
        addedBg: '#0D2E1F',
        addedBorder: '#3FB950',
        addedText: '#C9D1D9',
        removedBg: '#3F1B23',
        removedBorder: '#F85149',
        removedText: '#C9D1D9',
        contextBg: '#161B22',
        contextText: '#8B949E',
        lineNumberBg: '#161B22',
        lineNumberText: '#6E7681',
        hunkHeaderBg: '#161B22',
        hunkHeaderText: '#58A6FF',
        leadingSpaceDot: '#2A2A2A',
        inlineAddedBg: '#2A5A2A',
        inlineAddedText: '#7AFF7A',
        inlineRemovedBg: '#5A2A2A',
        inlineRemovedText: '#FF7A7A',
    }
};

export const DiffView: React.FC<DiffViewProps> = ({
    oldText,
    newText,
    contextLines = 3,
    showLineNumbers = true,
    showDiffStats = true,
    oldTitle = 'Original',
    newTitle = 'Modified',
    className = '',
    style,
    maxHeight = 500,
    wrapLines = true,
    fontScaleX = 1,
}) => {
    const colorScheme = useColorScheme();
    const colors = COLORS[colorScheme ?? 'light'];
    const scrollRef = useRef<ScrollView>(null);

    // Calculate diff with inline highlighting
    const { hunks, stats } = useMemo(() => {
        return calculateUnifiedDiff(oldText, newText, contextLines);
    }, [oldText, newText, contextLines]);

    // Styles
    const containerStyle: ViewStyle = {
        backgroundColor: colors.surface,
        borderWidth: 0,
        flex: 1,
        ...style,
    };

    const headerStyle: ViewStyle = {
        backgroundColor: colors.surfaceVariant,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.outline,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    };

    const titleStyle: TextStyle = {
        fontSize: 14,
        fontWeight: '600',
        color: colors.onSurface,
    };

    const statsStyle: TextStyle = {
        fontSize: 12,
        ...Typography.mono(),
    };

    // Fixed width for line numbers - just enough for 3 digits
    const lineNumberWidth = 25;
    
    // Scroll past line numbers when not wrapping and showing line numbers
    useEffect(() => {
        if (!wrapLines && showLineNumbers) {
            // Delay to ensure layout is complete
            setTimeout(() => {
                if (scrollRef.current) {
                    // Account for font scale when calculating scroll position
                    const scaledWidth = lineNumberWidth * fontScaleX;
                    scrollRef.current.scrollTo({ x: scaledWidth, animated: false });
                }
            }, 50);
        }
    }, [wrapLines, showLineNumbers, lineNumberWidth, fontScaleX]);

    const lineNumberStyle: TextStyle = {
        fontSize: 10,
        ...Typography.mono(),
        color: colors.lineNumberText,
        minWidth: lineNumberWidth,
        textAlign: 'right',
        paddingRight: 3,
        paddingLeft: 2,
        backgroundColor: colors.lineNumberBg,
    };

    const lineContentStyle: TextStyle = {
        fontSize: 13,
        ...Typography.mono(),
        flex: 1,
    };

    // Helper function to format line content
    const formatLineContent = (content: string) => {
        // Just trim trailing spaces, we'll handle leading spaces in rendering
        return content.trimEnd();
    };
    
    // Helper function to render line with styled leading space dots and inline highlighting
    const renderLineContent = (content: string, textStyle: any, tokens?: DiffToken[]) => {
        const formatted = formatLineContent(content);
        const leadingSpaces = formatted.match(/^( +)/);
        const leadingDots = leadingSpaces ? '\u00b7'.repeat(leadingSpaces[0].length) : '';
        const mainContent = leadingSpaces ? formatted.slice(leadingSpaces[0].length) : formatted;
        
        if (tokens && tokens.length > 0) {
            // Render with inline highlighting
            return (
                <View style={{ flexDirection: 'row', flex: 1 }}>
                    <Text style={[textStyle, { transform: [{ scaleX: fontScaleX }] }]}>
                        {leadingDots && <Text style={{ color: colors.leadingSpaceDot }}>{leadingDots}</Text>}
                        {tokens.map((token, idx) => {
                            if (token.added || token.removed) {
                                return (
                                    <Text 
                                        key={idx} 
                                        style={{ 
                                            backgroundColor: token.added ? colors.inlineAddedBg : colors.inlineRemovedBg,
                                            color: token.added ? colors.inlineAddedText : colors.inlineRemovedText,
                                        }}
                                    >
                                        {token.value}
                                    </Text>
                                );
                            }
                            return <Text key={idx}>{token.value}</Text>;
                        })}
                    </Text>
                </View>
            );
        }
        
        // Regular rendering without tokens
        return (
            <View style={{ flexDirection: 'row', flex: 1 }}>
                <Text style={[textStyle, { transform: [{ scaleX: fontScaleX }] }]}>
                    {leadingDots && <Text style={{ color: colors.leadingSpaceDot }}>{leadingDots}</Text>}
                    {mainContent}
                </Text>
            </View>
        );
    };

    // Render content
    const content = (
            <View>
            {hunks.map((hunk, hunkIndex) => (
                <View key={hunkIndex}>
                    {hunkIndex > 0 && (
                        <View style={{
                            backgroundColor: colors.hunkHeaderBg,
                            paddingVertical: 8,
                            paddingHorizontal: 16,
                            borderTopWidth: 1,
                            borderTopColor: colors.outline,
                            borderBottomWidth: 1,
                            borderBottomColor: colors.outline,
                        }}>
                            <Text style={{
                                color: colors.hunkHeaderText,
                                fontSize: 12,
                                ...Typography.mono(),
                            }}>
                                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                            </Text>
                        </View>
                    )}

                    {hunk.lines.map((line, lineIndex) => {
                        const isAdded = line.type === 'add';
                        const isRemoved = line.type === 'remove';

                        const lineStyle: ViewStyle = {
                            flexDirection: 'row',
                            backgroundColor: isAdded
                                ? colors.addedBg
                                : isRemoved
                                    ? colors.removedBg
                                    : colors.contextBg,
                            borderLeftWidth: 3,
                            borderLeftColor: isAdded
                                ? colors.addedBorder
                                : isRemoved
                                    ? colors.removedBorder
                                    : 'transparent',
                        };

                        const textColor = isAdded
                            ? colors.addedText
                            : isRemoved
                                ? colors.removedText
                                : colors.contextText;

                        return (
                            <View key={`${hunkIndex}-${lineIndex}`} style={lineStyle}>
                                {showLineNumbers && (
                                    <Text style={[lineNumberStyle, { transform: [{ scaleX: fontScaleX }] }]}>
                                        {line.type === 'remove' ? line.oldLineNumber : 
                                         line.type === 'add' ? line.newLineNumber : 
                                         line.oldLineNumber}
                                    </Text>
                                )}

                                <Text style={{
                                    transform: [{ scaleX: fontScaleX }],
                                    width: 24,
                                    textAlign: 'center',
                                    color: textColor,
                                    ...Typography.mono(),
                                    fontSize: 13,
                                    backgroundColor: isAdded ? colors.addedBg : isRemoved ? colors.removedBg : colors.contextBg,
                                }}>
                                    {isAdded ? '+' : isRemoved ? '-' : ' '}
                                </Text>

                                {renderLineContent(line.content, [
                                    lineContentStyle, 
                                    { 
                                        color: textColor,
                                        paddingRight: 20
                                    },
                                    !wrapLines && { flexWrap: 'nowrap' }
                                ], line.tokens)}
                            </View>
                        );
                    })}
                </View>
            ))}
            </View>
        );

        return (
            <ScrollView 
                style={{ flex: 1 }} 
                nestedScrollEnabled 
                showsVerticalScrollIndicator={true}
            >
                <ScrollView
                    ref={scrollRef}
                    horizontal={!wrapLines}
                    showsHorizontalScrollIndicator={!wrapLines}
                    contentContainerStyle={{ flexGrow: 1 }}
                >
                    {content}
                </ScrollView>
            </ScrollView>
        );

    return (
        <View style={containerStyle} className={className}>
            {/* Header */}
            <View style={headerStyle}>
                <Text style={titleStyle}>
                    {`${oldTitle} → ${newTitle}`}
                </Text>

                {showDiffStats && (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Text style={[statsStyle, { color: colors.success }]}>
                            +{stats.additions}
                        </Text>
                        <Text style={[statsStyle, { color: colors.error }]}>
                            -{stats.deletions}
                        </Text>
                    </View>
                )}
            </View>

            {/* Diff content */}
            <ScrollView 
                style={{ flex: 1 }} 
                nestedScrollEnabled 
                showsVerticalScrollIndicator={true}
            >
                <ScrollView
                    ref={scrollRef}
                    horizontal={!wrapLines}
                    showsHorizontalScrollIndicator={!wrapLines}
                    contentContainerStyle={{ flexGrow: 1 }}
                >
                    {content}
                </ScrollView>
            </ScrollView>
        </View>
    );
};

