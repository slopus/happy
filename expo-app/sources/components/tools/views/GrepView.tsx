import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../ToolSectionView';
import type { ToolViewProps } from './_all';
import { maybeParseJson } from '../utils/parseJson';

type GrepMatch = { file?: string; path?: string; line?: number; text?: string };

function coerceMatches(value: unknown): GrepMatch[] {
    const parsed = maybeParseJson(value);

    if (Array.isArray(parsed)) {
        const out: GrepMatch[] = [];
        for (const item of parsed) {
            if (typeof item === 'string') {
                out.push({ text: item });
            } else if (item && typeof item === 'object' && !Array.isArray(item)) {
                const obj = item as Record<string, unknown>;
                out.push({
                    file: typeof obj.file === 'string' ? obj.file : undefined,
                    path: typeof obj.path === 'string' ? obj.path : undefined,
                    line: typeof obj.line === 'number' ? obj.line : undefined,
                    text: typeof obj.text === 'string' ? obj.text : undefined,
                });
            }
        }
        return out;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const candidates = [obj.matches, obj.results, obj.items];
        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return coerceMatches(candidate);
            }
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

export const GrepView = React.memo<ToolViewProps>(({ tool }) => {
    if (tool.state !== 'completed') return null;
    const matches = coerceMatches(tool.result);
    if (matches.length === 0) return null;

    const max = 6;
    const shown = matches.slice(0, max);
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
                {more > 0 && <Text style={styles.more}>+{more} more</Text>}
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

