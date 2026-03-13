import type { PendingMessage } from '@/sync/storageTypes';
import { t } from '@/text';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getPendingPreviewText, truncatePendingPreview } from './pendingQueuePanelUtils';

type PendingActionType = 'send-now' | 'pin' | 'delete';

type PendingQueuePanelProps = {
    messages: PendingMessage[];
    canManage: boolean;
    onSendNow: (pendingId: string) => Promise<void> | void;
    onPin: (pendingId: string) => Promise<void> | void;
    onDelete: (pendingId: string) => Promise<void> | void;
};

export const PendingQueuePanel: React.FC<PendingQueuePanelProps> = React.memo(({ messages, canManage, onSendNow, onPin, onDelete }) => {
    const { theme } = useUnistyles();
    const [pendingAction, setPendingAction] = React.useState<{ pendingId: string; action: PendingActionType } | null>(null);

    const runAction = React.useCallback(async (pendingId: string, action: PendingActionType, handler: (id: string) => Promise<void> | void) => {
        if (pendingAction !== null) {
            return;
        }

        setPendingAction({ pendingId, action });
        try {
            await handler(pendingId);
        } finally {
            setPendingAction((current) => {
                if (current?.pendingId === pendingId && current.action === action) {
                    return null;
                }
                return current;
            });
        }
    }, [pendingAction]);

    if (messages.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <Text style={styles.title}>{t('pendingQueue.title')}</Text>
                <Text style={styles.count}>{messages.length}</Text>
            </View>

            <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator
            >
                {messages.map((message) => {
                    const isAnyActionLoading = pendingAction?.pendingId === message.id;

                    return (
                        <View key={message.id} style={styles.itemRow}>
                            <View style={styles.itemTextColumn}>
                                <Text style={styles.preview} numberOfLines={2}>
                                    {truncatePendingPreview(getPendingPreviewText(message.previewText, t('pendingQueue.empty')))}
                                </Text>
                                {message.pinnedAt !== null && (
                                    <Text style={styles.meta}>📌</Text>
                                )}
                            </View>

                            {canManage && (
                                <View style={styles.actions}>
                                    {isAnyActionLoading ? (
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    ) : (
                                        <>
                                            <Pressable
                                                style={styles.actionButton}
                                                onPress={() => void runAction(message.id, 'send-now', onSendNow)}
                                            >
                                                <Text style={[styles.actionText, styles.sendNowText]}>{t('pendingQueue.sendNow')}</Text>
                                            </Pressable>

                                            <Pressable
                                                style={[styles.actionButton, message.pinnedAt !== null && styles.actionButtonDisabled]}
                                                onPress={() => void runAction(message.id, 'pin', onPin)}
                                                disabled={message.pinnedAt !== null}
                                            >
                                                <Text style={[styles.actionText, styles.pinText, message.pinnedAt !== null && styles.actionTextDisabled]}>{t('pendingQueue.pin')}</Text>
                                            </Pressable>

                                            <Pressable
                                                style={styles.actionButton}
                                                onPress={() => void runAction(message.id, 'delete', onDelete)}
                                            >
                                                <Text style={[styles.actionText, styles.deleteText]}>{t('pendingQueue.delete')}</Text>
                                            </Pressable>
                                        </>
                                    )}
                                </View>
                            )}
                        </View>
                    );
                })}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 8,
        gap: 8,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    title: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    count: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '500',
    },
    list: {
        maxHeight: 180,
    },
    listContent: {
        gap: 8,
    },
    itemRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    itemTextColumn: {
        flexBasis: 0,
        flexGrow: 1,
        gap: 4,
    },
    preview: {
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
    },
    meta: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '500',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actionButton: {
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    actionButtonDisabled: {
        opacity: 0.4,
    },
    actionText: {
        fontSize: 12,
        fontWeight: '600',
    },
    actionTextDisabled: {
        color: theme.colors.textSecondary,
    },
    sendNowText: {
        color: theme.colors.textLink,
    },
    pinText: {
        color: theme.colors.status.connecting,
    },
    deleteText: {
        color: theme.colors.textDestructive,
    },
}));
