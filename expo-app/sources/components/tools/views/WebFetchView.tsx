import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { CodeView } from '@/components/CodeView';
import { maybeParseJson } from '../utils/parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function getText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string' && parsed.trim()) return parsed;
    const obj = asRecord(parsed);
    if (!obj) return null;
    const candidates = [obj.text, obj.content, obj.body, obj.markdown, obj.result, obj.output];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
    }
    return null;
}

export const WebFetchView = React.memo<ToolViewProps>(({ tool }) => {
    if (tool.state !== 'completed') return null;
    const url = typeof tool.input?.url === 'string' ? tool.input.url : null;
    const text = getText(tool.result);
    if (!url && !text) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {url ? <Text style={styles.url} numberOfLines={2}>{url}</Text> : null}
                {text ? <CodeView code={truncate(text, 2200)} /> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 10,
    },
    url: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
