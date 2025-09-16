import * as React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';

// ANSI color codes mapping
const ANSI_COLORS: Record<string, string> = {
    '30': '#000000', // black
    '31': '#cd3131', // red
    '32': '#0dbc79', // green
    '33': '#e5e510', // yellow
    '34': '#2472c8', // blue
    '35': '#bc3fbc', // magenta
    '36': '#11a8cd', // cyan
    '37': '#e5e5e5', // white
    '90': '#666666', // bright black (gray)
    '91': '#f14c4c', // bright red
    '92': '#23d18b', // bright green
    '93': '#f5f543', // bright yellow
    '94': '#3b8eea', // bright blue
    '95': '#d670d6', // bright magenta
    '96': '#29b8db', // bright cyan
    '97': '#ffffff', // bright white
};

const ANSI_BG_COLORS: Record<string, string> = {
    '40': '#000000', // black
    '41': '#cd3131', // red
    '42': '#0dbc79', // green
    '43': '#e5e510', // yellow
    '44': '#2472c8', // blue
    '45': '#bc3fbc', // magenta
    '46': '#11a8cd', // cyan
    '47': '#e5e5e5', // white
    '100': '#666666', // bright black (gray)
    '101': '#f14c4c', // bright red
    '102': '#23d18b', // bright green
    '103': '#f5f543', // bright yellow
    '104': '#3b8eea', // bright blue
    '105': '#d670d6', // bright magenta
    '106': '#29b8db', // bright cyan
    '107': '#ffffff', // bright white
};

interface ParsedSegment {
    text: string;
    color?: string;
    backgroundColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
}

function parseAnsiText(text: string): ParsedSegment[] {
    const segments: ParsedSegment[] = [];
    const ansiRegex = /\x1b\[([0-9;]*)m/g;
    
    let lastIndex = 0;
    let currentStyle: Partial<ParsedSegment> = {};
    
    let match;
    while ((match = ansiRegex.exec(text)) !== null) {
        // Add text before this escape sequence
        if (match.index > lastIndex) {
            const textSegment = text.slice(lastIndex, match.index);
            if (textSegment) {
                segments.push({ text: textSegment, ...currentStyle });
            }
        }
        
        // Parse the escape sequence
        const codes = match[1] ? match[1].split(';').filter(code => code !== '') : ['0'];
        
        for (const code of codes) {
            const codeNum = parseInt(code, 10);
            
            switch (code) {
                case '0':
                    currentStyle = {}; // reset all styles
                    break;
                case '1':
                    currentStyle.bold = true;
                    break;
                case '3':
                    currentStyle.italic = true;
                    break;
                case '4':
                    currentStyle.underline = true;
                    break;
                case '22':
                    currentStyle.bold = false;
                    break;
                case '23':
                    currentStyle.italic = false;
                    break;
                case '24':
                    currentStyle.underline = false;
                    break;
                case '39':
                    delete currentStyle.color; // reset foreground color
                    break;
                case '49':
                    delete currentStyle.backgroundColor; // reset background color
                    break;
                default:
                    if (ANSI_COLORS[code]) {
                        currentStyle.color = ANSI_COLORS[code];
                    } else if (ANSI_BG_COLORS[code]) {
                        currentStyle.backgroundColor = ANSI_BG_COLORS[code];
                    } else if (codeNum >= 30 && codeNum <= 37) {
                        // Standard foreground colors
                        currentStyle.color = ANSI_COLORS[code];
                    } else if (codeNum >= 40 && codeNum <= 47) {
                        // Standard background colors
                        currentStyle.backgroundColor = ANSI_BG_COLORS[code];
                    } else if (codeNum >= 90 && codeNum <= 97) {
                        // Bright foreground colors
                        currentStyle.color = ANSI_COLORS[code];
                    } else if (codeNum >= 100 && codeNum <= 107) {
                        // Bright background colors
                        currentStyle.backgroundColor = ANSI_BG_COLORS[code];
                    }
                    break;
            }
        }
        
        lastIndex = ansiRegex.lastIndex;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex);
        if (remaining) {
            segments.push({ text: remaining, ...currentStyle });
        }
    }
    
    return segments;
}

export interface TerminalViewProps {
    content: string;
    selectable?: boolean;
}

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const segments = React.useMemo(() => parseAnsiText(props.content), [props.content]);
    
    const handleCopy = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            Modal.alert(t('common.success'), t('items.copiedToClipboard', { label: 'Terminal output' }));
        } catch (error) {
            console.error('Failed to copy to clipboard:', error);
            Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
        }
    }, [props.content]);
    
    return (
        <View style={styles.container}>
            <Pressable style={styles.copyButton} onPress={handleCopy}>
                <Text style={styles.copyButtonText}>Copy</Text>
            </Pressable>
            <ScrollView
                style={styles.scrollView}
                horizontal={true}
                contentContainerStyle={styles.contentContainer}
                showsHorizontalScrollIndicator={false}
            >
                <Text selectable={props.selectable} style={styles.terminalText}>
                    {segments.map((segment, index) => (
                        <Text
                            key={index}
                            style={[
                                styles.segment,
                                segment.color && { color: segment.color },
                                segment.backgroundColor && { backgroundColor: segment.backgroundColor },
                                segment.bold && styles.bold,
                                segment.italic && styles.italic,
                                segment.underline && styles.underline,
                            ]}
                        >
                            {segment.text}
                        </Text>
                    ))}
                </Text>
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        backgroundColor: '#1e1e1e', // Dark terminal background
        borderRadius: 8,
        marginVertical: 8,
        position: 'relative',
    },
    copyButton: {
        position: 'absolute',
        top: 8,
        right: 8,
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        zIndex: 1,
    },
    copyButtonText: {
        ...Typography.mono(),
        fontSize: 12,
        color: '#ffffff',
    },
    scrollView: {
        flexGrow: 0,
        flexShrink: 0,
    },
    contentContainer: {
        paddingHorizontal: 16,
        paddingVertical: 16,
        paddingTop: 40, // Extra padding to account for copy button
        flexDirection: 'row',
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 20,
        color: '#e5e5e5', // Default terminal text color
        flexWrap: 'nowrap',
    },
    segment: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 20,
    },
    bold: {
        fontWeight: 'bold',
    },
    italic: {
        fontStyle: 'italic',
    },
    underline: {
        textDecorationLine: 'underline',
    },
}));