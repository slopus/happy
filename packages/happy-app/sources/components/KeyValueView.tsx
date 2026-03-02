import * as React from 'react';
import { Text, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodeView } from './CodeView';

interface KeyValueViewProps {
    data: Record<string, unknown>;
}

function formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function isSimpleValue(value: unknown): boolean {
    return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export const KeyValueView = React.memo<KeyValueViewProps>(({ data }) => {
    const entries = Object.entries(data);

    return (
        <View style={styles.container}>
            {entries.map(([key, value], index) => (
                <View key={key} style={[styles.row, index < entries.length - 1 && styles.rowBorder]}>
                    <Text style={styles.key} numberOfLines={1}>{key}</Text>
                    {isSimpleValue(value) ? (
                        <Text style={styles.value} selectable>{formatValue(value)}</Text>
                    ) : (
                        <View style={styles.complexValue}>
                            <CodeView code={formatValue(value)} />
                        </View>
                    )}
                </View>
            ))}
        </View>
    );
});

/**
 * Tries to render data as key-value pairs.
 * Falls back to CodeView with raw JSON if the input is not a plain object.
 */
export function ToolInputView({ input }: { input: unknown }) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return <KeyValueView data={input as Record<string, unknown>} />;
    }

    // Fallback: raw JSON
    try {
        return <CodeView code={JSON.stringify(input, null, 2)} />;
    } catch {
        return <CodeView code={String(input)} />;
    }
}

/**
 * Smart view for tool output: if the data is a plain object, render as key-value pairs.
 * If it's a JSON string that parses to an object, render as key-value pairs.
 * Otherwise, render as raw text in CodeView.
 */
export function SmartDataView({ data }: { data: unknown }) {
    // Already an object
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return <KeyValueView data={data as Record<string, unknown>} />;
    }

    // String: try to parse as JSON object
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return <KeyValueView data={parsed as Record<string, unknown>} />;
                }
            } catch {
                // Not valid JSON, fall through
            }
        }
        return <CodeView code={data} />;
    }

    // Fallback
    try {
        return <CodeView code={JSON.stringify(data, null, 2)} />;
    } catch {
        return <CodeView code={String(data)} />;
    }
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        overflow: 'hidden',
    },
    row: {
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    rowBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.modal.border,
    },
    key: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        marginBottom: 4,
    },
    value: {
        fontSize: 13,
        color: theme.colors.text,
        lineHeight: 19,
    },
    complexValue: {
        marginTop: 2,
    },
}));
