import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { CodeView } from '@/components/CodeView';
import { maybeParseJson } from '../utils/parseJson';
import { tailTextWithEllipsis } from '../utils/stdStreams';

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        out.push(item);
    }
    return out;
}

function coerceTextFromBlockArray(value: unknown): string | null {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const item of value) {
        if (typeof item === 'string') {
            if (item.trim()) parts.push(item);
            continue;
        }
        const obj = asRecord(item);
        if (!obj) continue;
        const text = asString(obj.text) ?? asString(obj.content) ?? asString(obj.message);
        if (text && text.trim()) parts.push(text);
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
}

function getStdStreams(result: unknown): { stdout?: string; stderr?: string; exitCode?: number } | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (!obj) return null;

    const stdout = asString(obj.stdout) ?? asString(obj.out) ?? undefined;
    const stderr = asString(obj.stderr) ?? asString(obj.err) ?? undefined;
    const exitCode = asNumber(obj.exitCode) ?? asNumber(obj.code) ?? undefined;
    if (!stdout && !stderr && typeof exitCode !== 'number') return null;
    return { stdout, stderr, exitCode };
}

function getDiff(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (obj && typeof obj.diff === 'string' && obj.diff.trim()) return obj.diff;
    return null;
}

function getPaths(result: unknown): string[] {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (obj) {
        const candidates = [obj.paths, obj.files, obj.matches];
        for (const c of candidates) {
            const arr = coerceStringArray(c);
            if (arr) return arr;
        }
    }
    const direct = coerceStringArray(parsed);
    return direct ?? [];
}

function getText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string' && parsed.trim()) return parsed;
    const obj = asRecord(parsed);
    if (!obj) return null;
    if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
    if (typeof obj.reason === 'string' && obj.reason.trim()) return obj.reason;
    if (obj.error && typeof obj.error === 'object') {
        const errObj = asRecord(obj.error);
        const msg = errObj ? asString(errObj.message) : null;
        if (msg && msg.trim()) return msg;
    }
    const candidates = [
        obj.text,
        obj.content,
        obj.body,
        obj.markdown,
        obj.message,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
        const blockText = coerceTextFromBlockArray(c);
        if (blockText && blockText.trim()) return blockText;
    }
    return null;
}

export const StructuredResultView = React.memo<ToolViewProps>(({ tool }) => {
    const { theme } = useUnistyles();
    if (tool.state !== 'completed' && tool.state !== 'running') return null;
    if (!tool.result) return null;

    const streams = getStdStreams(tool.result);
    const diff = getDiff(tool.result);
    const paths = getPaths(tool.result);
    const text = getText(tool.result);

    // When running, only render stdio-like streams (avoid showing partial diffs/paths).
    if (tool.state === 'running' && !streams) return null;

    if (!streams && !diff && paths.length === 0 && !text) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {typeof streams?.exitCode === 'number' && (
                    <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                        exit {streams.exitCode}
                    </Text>
                )}

                {streams?.stdout && streams.stdout.trim() ? (
                    <View style={styles.block}>
                        <Text style={styles.label}>stdout</Text>
                        <CodeView
                            code={
                                tool.state === 'running'
                                    ? tailTextWithEllipsis(streams.stdout, 1200)
                                    : truncate(streams.stdout, 2000)
                            }
                        />
                    </View>
                ) : null}

                {streams?.stderr && streams.stderr.trim() ? (
                    <View style={styles.block}>
                        <Text style={styles.label}>stderr</Text>
                        <CodeView
                            code={
                                tool.state === 'running'
                                    ? tailTextWithEllipsis(streams.stderr, 900)
                                    : truncate(streams.stderr, 1200)
                            }
                        />
                    </View>
                ) : null}

                {diff && (
                    <View style={styles.block}>
                        <Text style={styles.label}>diff</Text>
                        <CodeView code={truncate(diff, 2200)} />
                    </View>
                )}

                {!streams?.stdout && !streams?.stderr && !diff && text && (
                    <View style={styles.block}>
                        <Text style={styles.label}>result</Text>
                        <CodeView code={truncate(text, 2200)} />
                    </View>
                )}

                {paths.length > 0 && (
                    <View style={styles.block}>
                        <Text style={styles.label}>items</Text>
                        {paths.slice(0, 8).map((p, idx) => (
                            <Text key={`${idx}-${p}`} style={styles.path} numberOfLines={1}>
                                {p}
                            </Text>
                        ))}
                        {paths.length > 8 && (
                            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                                +{paths.length - 8} more
                            </Text>
                        )}
                    </View>
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
        gap: 10,
    },
    block: {
        gap: 6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    path: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
    meta: {
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));
