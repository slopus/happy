import { Ionicons } from '@expo/vector-icons';
import type { PendingMessage } from '@/sync/storageTypes';
import { t } from '@/text';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from './layout';
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
            <View style={styles.innerContainer}>
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
                                    <Text
                                        style={[styles.preview, message.pinnedAt !== null && styles.previewPinned]}
                                        numberOfLines={2}
                                    >
                                        {truncatePendingPreview(getPendingPreviewText(message.previewText, t('pendingQueue.empty')))}
                                    </Text>
                                </View>

                                {canManage && (
                                    <View style={styles.actions}>
                                        {isAnyActionLoading ? (
                                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                        ) : (
                                            <>
                                                <Pressable
                                                    style={styles.iconButton}
                                                    onPress={() => void runAction(message.id, 'send-now', onSendNow)}
                                                    accessibilityLabel={t('pendingQueue.sendNow')}
                                                    hitSlop={8}
                                                >
                                                    <Ionicons name="paper-plane-outline" size={16} color={theme.colors.textLink} />
                                                </Pressable>

                                                <Pressable
                                                    style={styles.iconButton}
                                                    onPress={() => void runAction(message.id, 'pin', onPin)}
                                                    accessibilityLabel={t('pendingQueue.pin')}
                                                    hitSlop={8}
                                                >
                                                    <Ionicons
                                                        name={message.pinnedAt !== null ? 'pin' : 'pin-outline'}
                                                        size={16}
                                                        color={message.pinnedAt !== null ? theme.colors.textLink : theme.colors.textSecondary}
                                                    />
                                                </Pressable>

                                                <Pressable
                                                    style={styles.iconButton}
                                                    onPress={() => void runAction(message.id, 'delete', onDelete)}
                                                    accessibilityLabel={t('pendingQueue.delete')}
                                                    hitSlop={8}
                                                >
                                                    <Ionicons name="trash-outline" size={16} color={theme.colors.textDestructive} />
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
        alignItems: 'center',
    },
    innerContainer: {
        width: '100%',
        maxWidth: layout.maxWidth,
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
    },
    preview: {
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
    },
    previewPinned: {
        fontWeight: '700',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginLeft: 4,
    },
    iconButton: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
