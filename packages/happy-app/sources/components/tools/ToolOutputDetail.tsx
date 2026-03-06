import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { ToolCall } from '@/sync/typesMessage';
import { CommandView } from '../CommandView';
import { CodeView } from '../CodeView';
import { SmartDataView } from '../KeyValueView';
import { formatToolOutputContent, isTrimmedToolOutput } from './toolOutputContent';

interface ToolOutputDetailProps {
    tool: ToolCall;
}

interface GetToolOutputResponse {
    success: boolean;
    result?: unknown;
    error?: string;
}

export const ToolOutputDetail = React.memo<ToolOutputDetailProps>(({ tool }) => {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const marker = isTrimmedToolOutput(tool.result) ? tool.result : null;
    const [loading, setLoading] = React.useState(Boolean(marker));
    const [error, setError] = React.useState<string | null>(null);
    const [loadedResult, setLoadedResult] = React.useState<unknown>(null);

    React.useEffect(() => {
        if (!marker) {
            setLoading(false);
            setError(null);
            setLoadedResult(null);
            return;
        }

        let cancelled = false;

        const loadResult = async () => {
            if (!sessionId) {
                setLoading(false);
                setError('Result not available');
                return;
            }

            setLoading(true);
            setError(null);

            try {
                const response = await apiSocket.sessionRPC<GetToolOutputResponse, { callId: string }>(
                    sessionId,
                    'getToolOutput',
                    { callId: marker._callId }
                );

                if (cancelled) {
                    return;
                }

                if (response.success) {
                    setLoadedResult(response.result);
                } else {
                    setError(response.error || 'Result not available');
                }
            } catch (fetchError: any) {
                if (!cancelled) {
                    setError(fetchError?.message || 'Failed to load output');
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadResult();

        return () => {
            cancelled = true;
        };
    }, [marker?._callId, sessionId]);

    if (!marker) {
        return <SmartDataView data={tool.result} />;
    }

    if (loading) {
        return (
            <View style={styles.stateContainer}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    if (error) {
        const summary = getSummaryData(marker);
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
                {summary ? <SmartDataView data={summary} /> : null}
            </View>
        );
    }

    const content = formatToolOutputContent({
        toolName: tool.name,
        toolInput: tool.input,
        result: loadedResult,
        kind: marker._toolResultKind,
    });

    if (content.kind === 'command') {
        return (
            <CommandView
                command={content.command}
                stdout={content.stdout}
                stderr={content.stderr}
                error={content.error}
                fullWidth
            />
        );
    }

    if (content.kind === 'text') {
        return <CodeView code={content.text} />;
    }

    return <SmartDataView data={content.data} />;
});

function getSummaryData(marker: object): Record<string, unknown> | null {
    const summary = Object.fromEntries(
        Object.entries(marker as Record<string, unknown>).filter(([key]) => !key.startsWith('_'))
    );
    return Object.keys(summary).length > 0 ? summary : null;
}

const styles = StyleSheet.create((theme) => ({
    stateContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 72,
    },
    errorContainer: {
        gap: 12,
    },
    errorText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));
