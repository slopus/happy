import * as React from 'react';
import { Text, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodeView } from './CodeView';
import { LongPressCopy, useCopySelectable } from './LongPressCopy';
import {
    type OrchestratorSubmitTaskInput,
    formatPromptPreview,
    isOrchestratorSubmitToolName,
    parseOrchestratorSubmitTasks,
} from './keyValueOrchestratorSubmit';

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
    const selectable = useCopySelectable();
    const allText = entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join('\n');

    return (
        <LongPressCopy text={allText}>
            <View style={styles.container}>
                {entries.map(([key, value], index) => (
                    <View key={key} style={[styles.row, index < entries.length - 1 && styles.rowBorder]}>
                        <Text style={styles.key} numberOfLines={1}>{key}</Text>
                        {isSimpleValue(value) ? (
                            <Text style={styles.value} selectable={selectable}>{formatValue(value)}</Text>
                        ) : (
                            <View style={styles.complexValue}>
                                <CodeView code={formatValue(value)} />
                            </View>
                        )}
                    </View>
                ))}
            </View>
        </LongPressCopy>
    );
});

function OrchestratorSubmitInputView({ input }: { input: Record<string, unknown> }) {
    const topLevelEntries = Object.entries(input).filter(([key]) => key !== 'tasks');
    const tasksRaw = input.tasks;
    const tasks = parseOrchestratorSubmitTasks(tasksRaw);
    const selectable = useCopySelectable();

    return (
        <LongPressCopy text={JSON.stringify(input, null, 2)}>
            <View style={styles.container}>
                {topLevelEntries.map(([key, value], index) => (
                    <View key={key} style={[styles.row, index < topLevelEntries.length - 1 && styles.rowBorder]}>
                        <Text style={styles.key} numberOfLines={1}>{key}</Text>
                        {isSimpleValue(value) ? (
                            <Text style={styles.value} selectable={selectable}>{formatValue(value)}</Text>
                        ) : (
                            <View style={styles.complexValue}>
                                <CodeView code={formatValue(value)} />
                            </View>
                        )}
                    </View>
                ))}

                <View style={[styles.row, topLevelEntries.length > 0 && styles.rowTopBorder]}>
                    <Text style={styles.key} numberOfLines={1}>tasks</Text>
                    {tasks.length > 0 ? (
                        <View style={styles.tasksList}>
                            {tasks.map((task, index) => {
                                const taskTitle = task.title || task.taskKey || `Task ${index + 1}`;
                                const promptPreview = task.prompt ? formatPromptPreview(task.prompt) : null;
                                return (
                                    <View key={`${task.taskKey ?? task.title ?? 'task'}-${index}`} style={styles.taskCard}>
                                        <Text style={styles.taskTitle} numberOfLines={1}>
                                            #{index + 1} {taskTitle}
                                        </Text>
                                        {(task.provider || task.model) ? (
                                            <Text style={styles.taskMeta}>
                                                {[task.provider, task.model].filter(Boolean).join(' · ')}
                                            </Text>
                                        ) : null}
                                        {task.dependsOn && task.dependsOn.length > 0 ? (
                                            <Text style={styles.taskMeta}>dependsOn: {task.dependsOn.join(', ')}</Text>
                                        ) : null}
                                        {typeof task.timeoutMs === 'number' ? (
                                            <Text style={styles.taskMeta}>timeoutMs: {task.timeoutMs}</Text>
                                        ) : null}
                                        {promptPreview ? (
                                            <View style={styles.taskPromptWrap}>
                                                <Text style={styles.taskMetaLabel}>prompt</Text>
                                                <Text style={styles.taskPromptText} selectable={selectable}>{promptPreview}</Text>
                                            </View>
                                        ) : null}
                                    </View>
                                );
                            })}
                        </View>
                    ) : (
                        <View style={styles.complexValue}>
                            <CodeView code={formatValue(tasksRaw)} />
                        </View>
                    )}
                </View>
            </View>
        </LongPressCopy>
    );
}

/**
 * Tries to render data as key-value pairs.
 * Falls back to CodeView with raw JSON if the input is not a plain object.
 */
export function ToolInputView({ input, toolName }: { input: unknown; toolName?: string }) {
    if (input == null) {
        return <CodeView code="null" />;
    }

    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const objectInput = input as Record<string, unknown>;
        if (Object.keys(objectInput).length === 0) {
            return <CodeView code="{}" />;
        }
        if (isOrchestratorSubmitToolName(toolName)) {
            return <OrchestratorSubmitInputView input={objectInput} />;
        }
        return <KeyValueView data={objectInput} />;
    }

    // Fallback: raw JSON
    try {
        const serialized = JSON.stringify(input, null, 2);
        return <CodeView code={serialized ?? String(input)} />;
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
    rowTopBorder: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.modal.border,
    },
    tasksList: {
        gap: 8,
        marginTop: 2,
    },
    taskCard: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.modal.border,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHighest,
        gap: 4,
    },
    taskTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
    taskMeta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 17,
    },
    taskMetaLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '600',
        marginBottom: 2,
    },
    taskPromptWrap: {
        marginTop: 2,
    },
    taskPromptText: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text,
    },
}));
