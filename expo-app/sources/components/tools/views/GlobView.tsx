import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolSectionView } from '../ToolSectionView';
import type { ToolViewProps } from './_registry';
import { maybeParseJson } from '../utils/parseJson';

function coerceStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        out.push(item);
    }
    return out;
}

function getGlobMatches(result: unknown): string[] {
    const parsed = maybeParseJson(result);

    const direct = coerceStringArray(parsed);
    if (direct) return direct;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const candidates = [obj.files, obj.matches, obj.paths, obj.results];
        for (const candidate of candidates) {
            const arr = coerceStringArray(candidate);
            if (arr) return arr;
        }
    }

    return [];
}

export const GlobView = React.memo<ToolViewProps>(({ tool }) => {
    const { theme } = useUnistyles();
    if (tool.state !== 'completed') return null;

    const matches = getGlobMatches(tool.result);
    if (matches.length === 0) return null;

    const max = 8;
    const shown = matches.slice(0, max);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {shown.map((path, idx) => (
                    <Text key={`${idx}-${path}`} style={styles.path} numberOfLines={1}>
                        {path}
                    </Text>
                ))}
                {more > 0 && (
                    <Text style={[styles.path, { color: theme.colors.textSecondary }]}>
                        +{more} more
                    </Text>
                )}
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
    path: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
}));
