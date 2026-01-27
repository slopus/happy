import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../ToolSectionView';
import type { ToolViewProps } from './_registry';
import { CodeView } from '@/components/CodeView';
import { maybeParseJson } from '../utils/parseJson';

function extractReadContent(result: unknown): { content: string; numLines?: number } | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
        return { content: parsed };
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const file = (obj.file && typeof obj.file === 'object' && !Array.isArray(obj.file)) ? (obj.file as Record<string, unknown>) : null;
        const content = (file && typeof file.content === 'string')
            ? file.content
            : (typeof obj.content === 'string')
                ? obj.content
                : null;
        if (!content) return null;

        const numLines = typeof file?.numLines === 'number' ? (file.numLines as number) : undefined;
        return { content, numLines };
    }

    return null;
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.length <= maxLines) return { text, truncated: false };
    return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

export const ReadView = React.memo<ToolViewProps>(({ tool }) => {
    if (tool.state !== 'completed') return null;
    const extracted = extractReadContent(tool.result);
    if (!extracted) return null;

    const { text, truncated } = truncateLines(extracted.content, 20);
    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <CodeView code={text} />
                {truncated ? <Text style={styles.more}>…</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 6,
    },
    more: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
