import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { maybeParseJson } from '../utils/parseJson';

type SearchMatch = { file?: string; path?: string; line?: number; text?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function coerceMatches(value: unknown): SearchMatch[] {
    const parsed = maybeParseJson(value);

    if (Array.isArray(parsed)) {
        const out: SearchMatch[] = [];
        for (const item of parsed) {
            if (typeof item === 'string') {
                out.push({ text: item });
            } else {
                const obj = asRecord(item);
                if (!obj) continue;
                out.push({
                    file: typeof obj.file === 'string' ? obj.file : undefined,
                    path: typeof obj.path === 'string' ? obj.path : (typeof obj.file_path === 'string' ? obj.file_path : undefined),
                    line: typeof obj.line === 'number' ? obj.line : (typeof obj.line_number === 'number' ? obj.line_number : undefined),
                    text: typeof obj.text === 'string' ? obj.text : (typeof obj.snippet === 'string' ? obj.snippet : undefined),
                });
            }
        }
        return out;
    }

    const obj = asRecord(parsed);
    if (obj) {
        const candidates = [obj.matches, obj.results, obj.items];
        for (const c of candidates) {
            if (Array.isArray(c)) return coerceMatches(c);
        }
        if (typeof obj.stdout === 'string') {
            return obj.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((text) => ({ text }));
        }
    }

    if (typeof parsed === 'string' && parsed.trim()) {
        return parsed
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((text) => ({ text }));
    }

    return [];
}

export const CodeSearchView = React.memo<ToolViewProps>(({ tool }) => {
    if (tool.state !== 'completed') return null;
    const matches = coerceMatches(tool.result);
    if (matches.length === 0) return null;

    const shown = matches.slice(0, 6);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {shown.map((m, idx) => {
                    const label = (m.path ?? m.file)
                        ? `${m.path ?? m.file}${typeof m.line === 'number' ? `:${m.line}` : ''}`
                        : null;
                    return (
                        <View key={idx} style={styles.row}>
                            {label ? <Text style={styles.label} numberOfLines={1}>{label}</Text> : null}
                            {m.text ? <Text style={styles.text} numberOfLines={2}>{m.text}</Text> : null}
                        </View>
                    );
                })}
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
        gap: 10,
    },
    row: {
        gap: 4,
    },
    label: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    text: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
    more: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
