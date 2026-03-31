import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { type v3 } from '@slopus/happy-sync';
import { t } from '@/text';

export const SubtaskPartView = React.memo((props: {
    part: v3.SubtaskPart;
    sessionId: string;
}) => {
    const { part } = props;
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);

    const toggleExpanded = React.useCallback(() => {
        setExpanded(prev => !prev);
    }, []);

    // Infer status from part data (result/status may be added at runtime)
    const partAny = part as any;
    const status: 'running' | 'completed' | 'error' =
        partAny.status === 'error' ? 'error' :
        partAny.result != null ? 'completed' :
        'running';

    const statusIcon = status === 'running'
        ? <ActivityIndicator size={14} color={theme.colors.textSecondary} />
        : status === 'error'
            ? <Ionicons name="close-circle" size={16} color={theme.colors.error} />
            : <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />;

    const agentLabel = part.agent
        ? part.agent + (part.model ? ` · ${part.model.modelID}` : '')
        : null;

    const resultPreview = !expanded && partAny.result
        ? String(partAny.result).split('\n')[0].slice(0, 60)
        : null;

    return (
        <View style={styles.container}>
            <TouchableOpacity style={styles.header} onPress={toggleExpanded} activeOpacity={0.8}>
                {statusIcon}
                <View style={styles.headerText}>
                    <View style={styles.titleRow}>
                        <Text style={styles.title} numberOfLines={1}>{part.description || t('message.subtask')}</Text>
                        {agentLabel && <Text style={styles.agentBadge} numberOfLines={1}>{agentLabel}</Text>}
                    </View>
                    {resultPreview && <Text style={styles.resultPreview} numberOfLines={1}>{resultPreview}</Text>}
                </View>
                <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={theme.colors.textSecondary}
                />
            </TouchableOpacity>
            {expanded && (
                <View style={styles.body}>
                    <Text style={styles.prompt}>{part.prompt}</Text>
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 8,
        marginVertical: 4,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    headerText: {
        flex: 1,
        gap: 2,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        flexShrink: 1,
    },
    agentBadge: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        overflow: 'hidden',
    },
    resultPreview: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    body: {
        padding: 12,
        gap: 4,
    },
    prompt: {
        fontSize: 13,
        color: theme.colors.text,
    },
}));
