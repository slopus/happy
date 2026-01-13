import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { CodeView } from '@/components/CodeView';

/**
 * Extract execute command info from Gemini's nested input format.
 */
function extractExecuteInfo(input: any): { command: string; description: string; cwd: string } {
    let command = '';
    let description = '';
    let cwd = '';
    
    // Try to get title from toolCall.title
    // Format: "rm file.txt [current working directory /path] (description)"
    if (input?.toolCall?.title) {
        const fullTitle = input.toolCall.title;
        
        // Extract command (before [)
        const bracketIdx = fullTitle.indexOf(' [');
        if (bracketIdx > 0) {
            command = fullTitle.substring(0, bracketIdx);
        } else {
            command = fullTitle;
        }
        
        // Extract cwd from [current working directory /path]
        const cwdMatch = fullTitle.match(/\[current working directory ([^\]]+)\]/);
        if (cwdMatch) {
            cwd = cwdMatch[1];
        }
        
        // Extract description from (...)
        const descMatch = fullTitle.match(/\(([^)]+)\)$/);
        if (descMatch) {
            description = descMatch[1];
        }
    }
    
    return { command, description, cwd };
}

/**
 * Gemini Execute View
 * 
 * Displays shell/terminal commands from Gemini's execute tool.
 */
export const GeminiExecuteView = React.memo<ToolViewProps>(({ tool }) => {
    const { command, description, cwd } = extractExecuteInfo(tool.input);

    if (!command) {
        return null;
    }

    return (
        <>
            <ToolSectionView fullWidth>
                <CodeView code={command} />
            </ToolSectionView>
            {(description || cwd) && (
                <View style={styles.infoContainer}>
                    {cwd && (
                        <Text style={styles.cwdText}>📁 {cwd}</Text>
                    )}
                    {description && (
                        <Text style={styles.descriptionText}>{description}</Text>
                    )}
                </View>
            )}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    infoContainer: {
        paddingHorizontal: 12,
        paddingBottom: 8,
    },
    cwdText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    descriptionText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
}));

