import type { FlowRunState, FlowStepRecord } from '@slopus/happy-sync';
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

function isFlowRunState(value: unknown): value is FlowRunState {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.runId === 'string' && typeof v.status === 'string' && Array.isArray(v.steps);
}

function formatDuration(startedAt: string, finishedAt?: string): string {
    const start = new Date(startedAt).getTime();
    const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const seconds = Math.round((end - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

const STATUS_LABELS: Record<FlowRunState['status'], string> = {
    running: 'Running',
    waiting: 'Waiting',
    completed: 'Completed',
    failed: 'Failed',
    timed_out: 'Timed out',
};

const OUTCOME_SYMBOLS: Record<FlowStepRecord['outcome'], string> = {
    ok: '\u2713',
    timed_out: '\u23F1',
    failed: '\u2717',
    cancelled: '\u2014',
};

export const FlowView = React.memo((props: { flow: unknown }) => {
    if (!isFlowRunState(props.flow)) {
        return null;
    }

    const flow = props.flow;
    const isTerminal = flow.status === 'completed' || flow.status === 'failed' || flow.status === 'timed_out';

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.flowName}>{flow.runTitle || flow.flowName}</Text>
                <Text style={[styles.status, isTerminal && flow.status !== 'completed' && styles.statusError, flow.status === 'completed' && styles.statusSuccess]}>
                    {STATUS_LABELS[flow.status]}
                </Text>
            </View>

            {flow.currentNode && !isTerminal ? (
                <Text style={styles.detail}>
                    Current: {flow.currentNode}{flow.statusDetail ? ` \u2014 ${flow.statusDetail}` : ''}
                </Text>
            ) : null}

            {flow.waitingOn ? (
                <Text style={styles.detail}>Waiting on: {flow.waitingOn}</Text>
            ) : null}

            {flow.error ? (
                <Text style={styles.errorText}>{flow.error}</Text>
            ) : null}

            {flow.steps.length > 0 ? (
                <View style={styles.steps}>
                    <Text style={styles.stepsLabel}>
                        Steps ({flow.steps.length})
                        {!isTerminal && flow.currentNode ? ` \u2014 ${flow.currentNode} in progress` : ''}
                    </Text>
                    {flow.steps.map((step) => (
                        <FlowStepRow key={step.attemptId} step={step} />
                    ))}
                </View>
            ) : null}

            <Text style={styles.timing}>
                {formatDuration(flow.startedAt, flow.finishedAt)}
                {isTerminal ? ' total' : ' elapsed'}
            </Text>
        </View>
    );
});

const FlowStepRow = React.memo(({ step }: { step: FlowStepRecord }) => {
    const symbol = OUTCOME_SYMBOLS[step.outcome];
    const isFailed = step.outcome === 'failed' || step.outcome === 'timed_out';

    return (
        <View style={styles.stepRow}>
            <Text style={[styles.stepOutcome, isFailed && styles.stepOutcomeFailed]}>{symbol}</Text>
            <View style={styles.stepInfo}>
                <Text style={styles.stepName} numberOfLines={1}>
                    {step.nodeId}
                    <Text style={styles.stepType}> ({step.nodeType})</Text>
                </Text>
                {step.error ? (
                    <Text style={styles.stepError} numberOfLines={2}>{step.error}</Text>
                ) : null}
            </View>
            <Text style={styles.stepDuration}>{formatDuration(step.startedAt, step.finishedAt)}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        marginHorizontal: 16,
        padding: 14,
        gap: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    flowName: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '600',
        flexShrink: 1,
    },
    status: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    statusSuccess: {
        color: theme.colors.text,
    },
    statusError: {
        color: theme.colors.text,
    },
    detail: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    errorText: {
        color: theme.colors.text,
        fontSize: 13,
    },
    steps: {
        gap: 4,
    },
    stepsLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
        marginBottom: 2,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
    },
    stepOutcome: {
        color: theme.colors.text,
        fontSize: 13,
        width: 16,
        textAlign: 'center',
    },
    stepOutcomeFailed: {
        color: theme.colors.text,
    },
    stepInfo: {
        flex: 1,
    },
    stepName: {
        color: theme.colors.text,
        fontSize: 13,
    },
    stepType: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    stepError: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 2,
    },
    stepDuration: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    timing: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
}));
