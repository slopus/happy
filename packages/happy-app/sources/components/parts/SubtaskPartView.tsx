import * as React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
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

    return (
        <View style={styles.container}>
            <TouchableOpacity style={styles.header} onPress={toggleExpanded} activeOpacity={0.8}>
                <Ionicons name="git-branch-outline" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.title} numberOfLines={1}>{part.description || t('message.subtask')}</Text>
                <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={theme.colors.textSecondary}
                />
            </TouchableOpacity>
            {expanded && (
                <View style={styles.body}>
                    <Text style={styles.prompt}>{part.prompt}</Text>
                    {part.agent && (
                        <Text style={styles.meta}>{part.agent}{part.model ? ` (${part.model.modelID})` : ''}</Text>
                    )}
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
    title: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    body: {
        padding: 12,
        gap: 4,
    },
    prompt: {
        fontSize: 13,
        color: theme.colors.text,
    },
    meta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
}));
