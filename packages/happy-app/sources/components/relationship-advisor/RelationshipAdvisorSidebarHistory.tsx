import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useLocalSetting, useLocalSettingUpdater } from '@/sync/storage';
import { t } from '@/text';
import {
    createRelationshipAdvisorConversation,
    removeRelationshipAdvisorConversation,
    saveRelationshipAdvisorConversation,
} from './relationshipAdvisorHistoryModel';

interface Props {
    desktopDensity?: boolean;
    fill?: boolean;
    onNavigate: (path: string) => void;
}

function conversationPath(conversationId: string): string {
    return `/relationship-advisor?conversationId=${encodeURIComponent(conversationId)}`;
}

export const RelationshipAdvisorSidebarHistory = React.memo(function RelationshipAdvisorSidebarHistory({
    desktopDensity = false,
    fill = false,
    onNavigate,
}: Props) {
    const { theme } = useUnistyles();
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ conversationId?: string | string[] }>();
    const conversations = useLocalSetting('relationshipAdvisorConversations');
    const updateConversations = useLocalSettingUpdater('relationshipAdvisorConversations');
    const currentParam = Array.isArray(params.conversationId) ? params.conversationId[0] : params.conversationId;
    const selectedId = pathname === '/relationship-advisor' ? currentParam : undefined;

    const createConversation = React.useCallback(() => {
        const conversation = createRelationshipAdvisorConversation(randomUUID(), t('relationshipAdvisor.newConversation'));
        updateConversations((current) => saveRelationshipAdvisorConversation(current, conversation));
        onNavigate(conversationPath(conversation.id));
    }, [onNavigate, updateConversations]);

    const deleteConversation = React.useCallback(async (conversationId: string) => {
        const confirmed = await Modal.confirm(
            t('relationshipAdvisor.deleteConfirmTitle'),
            t('relationshipAdvisor.deleteConfirmMessage'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;

        let nextPath = '/relationship-advisor';
        updateConversations((current) => {
            const remaining = removeRelationshipAdvisorConversation(current, conversationId);
            if (selectedId !== conversationId) return remaining;
            if (remaining[0]) {
                nextPath = conversationPath(remaining[0].id);
            }
            return remaining;
        });
        if (selectedId !== conversationId) return;
        onNavigate(nextPath);
    }, [onNavigate, selectedId, updateConversations]);

    return (
        <View style={[styles.section, desktopDensity && styles.sectionDesktop, fill && styles.sectionFill]} testID="relationship-advisor-sidebar-history">
            <View style={styles.header}>
                <View style={styles.headerTitleWrap}>
                    <Ionicons name="chatbubbles-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={styles.headerTitle} numberOfLines={1}>{t('relationshipAdvisor.historyTitle')}</Text>
                </View>
                <Pressable
                    accessibilityLabel={t('relationshipAdvisor.newConversation')}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={createConversation}
                    style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    testID="relationship-advisor-new-conversation"
                >
                    <Ionicons name="add" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            {conversations.length > 0 ? (
                <ScrollView style={[styles.list, fill && styles.listFill]} contentContainerStyle={styles.listContent}>
                    {conversations.map((conversation) => {
                        const selected = conversation.id === selectedId;
                        const preview = conversation.messages.at(-1)?.text || t('relationshipAdvisor.cloudSubtitle');
                        return (
                            <View
                                key={conversation.id}
                                style={[
                                    styles.row,
                                    selected && styles.rowSelected,
                                ]}
                                testID={`relationship-advisor-history-${conversation.id}`}
                            >
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() => onNavigate(conversationPath(conversation.id))}
                                    style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
                                >
                                    <View style={styles.rowCopy}>
                                        <Text style={styles.rowTitle} numberOfLines={1}>
                                            {conversation.title || t('relationshipAdvisor.newConversation')}
                                        </Text>
                                        <Text style={styles.rowPreview} numberOfLines={1}>{preview}</Text>
                                    </View>
                                </Pressable>
                                <Pressable
                                    accessibilityLabel={t('relationshipAdvisor.deleteConversationAccessibility')}
                                    accessibilityRole="button"
                                    hitSlop={6}
                                    onPress={() => void deleteConversation(conversation.id)}
                                    style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                                    testID={`relationship-advisor-delete-${conversation.id}`}
                                >
                                    <Ionicons name="trash-outline" size={14} color={theme.colors.textSecondary} />
                                </Pressable>
                            </View>
                        );
                    })}
                </ScrollView>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    section: {
        maxHeight: 232,
        marginHorizontal: 16,
        marginTop: 4,
        marginBottom: 4,
    },
    sectionDesktop: {
        marginHorizontal: 10,
        maxHeight: 208,
    },
    sectionFill: {
        flex: 1,
        marginBottom: 0,
        maxHeight: undefined,
        minHeight: 0,
    },
    header: {
        height: 36,
        flexDirection: 'row',
        alignItems: 'center',
    },
    headerTitleWrap: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    headerTitle: {
        flex: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    iconButton: {
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    list: {
        flexGrow: 0,
    },
    listFill: {
        flex: 1,
        minHeight: 0,
    },
    listContent: {
        gap: 2,
        paddingBottom: 4,
    },
    row: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 8,
        overflow: 'hidden',
    },
    rowMain: {
        flex: 1,
        minWidth: 0,
        alignSelf: 'stretch',
        justifyContent: 'center',
        paddingLeft: 10,
        paddingVertical: 6,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    rowPreview: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 15,
        ...Typography.default(),
    },
    deleteButton: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
