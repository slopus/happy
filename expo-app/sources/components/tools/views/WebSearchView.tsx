import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { maybeParseJson } from '../utils/parseJson';

type WebResult = { title?: string; url?: string; snippet?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function coerceResults(value: unknown): WebResult[] {
    const parsed = maybeParseJson(value);
    const arr = Array.isArray(parsed) ? parsed : null;
    const obj = asRecord(parsed);

    const candidates = arr
        ? arr
        : obj && Array.isArray(obj.results)
            ? obj.results
            : obj && Array.isArray(obj.items)
                ? obj.items
                : null;

    if (!candidates) return [];

    const out: WebResult[] = [];
    for (const item of candidates) {
        if (!item) continue;
        if (typeof item === 'string') {
            out.push({ url: item });
            continue;
        }
        const rec = asRecord(item);
        if (!rec) continue;
        out.push({
            title: typeof rec.title === 'string' ? rec.title : undefined,
            url: typeof rec.url === 'string' ? rec.url : (typeof rec.link === 'string' ? rec.link : undefined),
            snippet: typeof rec.snippet === 'string' ? rec.snippet : (typeof rec.description === 'string' ? rec.description : undefined),
        });
    }
    return out;
}

export const WebSearchView = React.memo<ToolViewProps>(({ tool }) => {
    if (tool.state !== 'completed') return null;
    const results = coerceResults(tool.result);
    if (results.length === 0) return null;

    const shown = results.slice(0, 5);
    const more = results.length - shown.length;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {shown.map((r, idx) => (
                    <View key={idx} style={styles.row}>
                        {r.title ? <Text style={styles.title} numberOfLines={2}>{r.title}</Text> : null}
                        {r.url ? <Text style={styles.url} numberOfLines={1}>{r.url}</Text> : null}
                        {r.snippet ? <Text style={styles.snippet} numberOfLines={3}>{r.snippet}</Text> : null}
                    </View>
                ))}
                {more > 0 ? <Text style={styles.more}>+{more} more</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 12,
    },
    row: {
        gap: 4,
    },
    title: {
        fontSize: 13,
        color: theme.colors.text,
        fontWeight: '500',
    },
    url: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    snippet: {
        fontSize: 13,
        color: theme.colors.text,
        opacity: 0.9,
    },
    more: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));

