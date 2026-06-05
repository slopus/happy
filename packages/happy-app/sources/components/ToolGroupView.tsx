import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { ToolGroupItem, generateGroupSummary } from '@/hooks/useGroupedMessages';
import { MessageView } from './MessageView';
import { Metadata } from '@/sync/storageTypes';
import { layout } from './layout';

interface ToolGroupViewProps {
    group: ToolGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
}

export const ToolGroupView = React.memo<ToolGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle } = props;
    const { theme } = useUnistyles();
    const summary = React.useMemo(() => generateGroupSummary(group.messages), [group.messages]);

    return (
        <View style={styles.outerContainer}>
            <View style={styles.innerContainer}>
                <Pressable
                    onPress={onToggle}
                    style={({ pressed }) => [
                        styles.header,
                        pressed && styles.headerPressed,
                    ]}
                >
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                    <Text style={styles.summaryText} numberOfLines={1}>
                        {summary}
                    </Text>
                    {group.hasRunning && (
                        <ActivityIndicator
                            size="small"
                            color={theme.colors.textSecondary}
                            style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                        />
                    )}
                </Pressable>
                {expanded && (
                    <View style={styles.content}>
                        {group.messages.map((msg) => (
                            <MessageView
                                key={msg.id}
                                message={msg}
                                metadata={metadata}
                                sessionId={sessionId}
                            />
                        ))}
                    </View>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    innerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        marginHorizontal: 8,
        marginVertical: 4,
        borderRadius: 8,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
    },
    headerPressed: {
        opacity: 0.7,
    },
    summaryText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    content: {
        marginTop: 2,
    },
}));
