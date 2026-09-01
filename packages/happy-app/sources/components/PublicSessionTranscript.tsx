import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { publicSessionSnapshotToMessages } from '@/sync/publicSessionSnapshotAdapter';
import { getPublicSessionAttachmentUrl } from '@/sync/publicSessionShareViewer';
import type { PublicSessionSnapshotV1 } from '@/sync/publicSessionShareTypes';
import { ConversationTranscript } from './ConversationTranscript';

export function PublicSessionTranscript({
    publicId,
    publishedAt,
    snapshot,
}: {
    publicId: string;
    publishedAt: number;
    snapshot: PublicSessionSnapshotV1;
}) {
    const messages = React.useMemo(() => publicSessionSnapshotToMessages(snapshot, {
        attachmentUrl: (attachmentId) => getPublicSessionAttachmentUrl(publicId, attachmentId),
    }), [publicId, snapshot]);
    return (
        <View style={styles.page} testID="public-session-transcript">
            <PublicTranscriptHeader
                title={snapshot.title}
                publishedAt={publishedAt}
                source={snapshot.source?.provider}
            />
            <View style={styles.transcript}>
                <View style={styles.transcriptFrame}>
                    <ConversationTranscript
                        metadata={null}
                        messages={messages}
                        groupToolCalls={snapshot.presentation?.groupToolCalls ?? true}
                        currentTurnActive={false}
                        hasPendingPermission={false}
                        visualTop={<View style={styles.transcriptTopInset} />}
                        visualBottom={<View style={styles.transcriptBottomInset} />}
                        showMessageActions={false}
                        canEditLatestUserMessage={false}
                        showAnchorNavigation={false}
                        inverted={false}
                    />
                </View>
            </View>
        </View>
    );
}

const sourceLabels = {
    paws: 'Paws',
    codex: 'Codex',
    'claude-code': 'Claude Code',
} as const;

function PublicTranscriptHeader({
    title,
    publishedAt,
    source,
}: {
    title: string;
    publishedAt: number;
    source?: keyof typeof sourceLabels;
}) {
    return (
        <View style={styles.headerFrame} testID="public-session-compact-header">
            <View style={styles.brandMark}>
                <Ionicons name="paw" size={15} color={styles.brandMarkIcon.color} />
            </View>
            <View style={styles.headerCopy}>
                <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{title}</Text>
                <View style={styles.metadataRow}>
                    {source ? (
                        <Text numberOfLines={1} style={styles.source} testID="public-session-source-label">
                            {sourceLabels[source]}
                        </Text>
                    ) : null}
                    <Text numberOfLines={1} style={styles.date}>
                        {new Date(publishedAt).toLocaleString()}
                    </Text>
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    transcript: {
        flex: 1,
        alignItems: 'center',
    },
    transcriptFrame: {
        flex: 1,
        width: '100%',
        maxWidth: layout.maxWidth - 40,
    },
    headerFrame: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 58,
        paddingHorizontal: 18,
        gap: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    brandMark: {
        width: 28,
        height: 28,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accent,
    },
    brandMarkIcon: { color: theme.colors.surface },
    headerCopy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
        fontWeight: '600' as const,
    },
    metadataRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    source: {
        color: theme.colors.accent,
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600' as const,
    },
    date: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
    },
    transcriptTopInset: { height: 22 },
    transcriptBottomInset: { height: 34 },
}));
