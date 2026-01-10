import React, { memo, useCallback, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { t } from '@/text';
import { SessionShare, ShareAccessLevel } from '@/sync/sharingTypes';
import { Avatar } from '@/components/Avatar';

/**
 * Props for the SessionShareDialog component
 */
interface SessionShareDialogProps {
    /** ID of the session being shared */
    sessionId: string;
    /** Current shares for this session */
    shares: SessionShare[];
    /** Whether the current user can manage shares (owner/admin) */
    canManage: boolean;
    /** Callback when user wants to add a new share */
    onAddShare: () => void;
    /** Callback when user updates share access level */
    onUpdateShare: (shareId: string, accessLevel: ShareAccessLevel) => void;
    /** Callback when user removes a share */
    onRemoveShare: (shareId: string) => void;
    /** Callback when user wants to create/manage public link */
    onManagePublicLink: () => void;
    /** Callback to close the dialog */
    onClose: () => void;
}

/**
 * Dialog for managing session sharing
 *
 * @remarks
 * Displays current shares and allows managing them. Shows:
 * - List of users the session is shared with
 * - Their access levels (view/edit/admin)
 * - Options to add/remove shares (if canManage)
 * - Link to public share management
 */
export const SessionShareDialog = memo(function SessionShareDialog({
    sessionId,
    shares,
    canManage,
    onAddShare,
    onUpdateShare,
    onRemoveShare,
    onManagePublicLink,
    onClose
}: SessionShareDialogProps) {
    const [selectedShareId, setSelectedShareId] = useState<string | null>(null);

    const handleSharePress = useCallback((shareId: string) => {
        if (canManage) {
            setSelectedShareId(selectedShareId === shareId ? null : shareId);
        }
    }, [canManage, selectedShareId]);

    const handleAccessLevelChange = useCallback((shareId: string, accessLevel: ShareAccessLevel) => {
        onUpdateShare(shareId, accessLevel);
        setSelectedShareId(null);
    }, [onUpdateShare]);

    const handleRemoveShare = useCallback((shareId: string) => {
        onRemoveShare(shareId);
        setSelectedShareId(null);
    }, [onRemoveShare]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('session.sharing.title')}</Text>
                <Item
                    title={t('common.close')}
                    onPress={onClose}
                />
            </View>

            <ScrollView style={styles.content}>
                <ItemList>
                    {/* Add share button */}
                    {canManage && (
                        <Item
                            title={t('session.sharing.shareWith')}
                            icon="person-add"
                            onPress={onAddShare}
                        />
                    )}

                    {/* Public link management */}
                    {canManage && (
                        <Item
                            title={t('session.sharing.publicLink')}
                            icon="link"
                            onPress={onManagePublicLink}
                        />
                    )}

                    {/* Current shares */}
                    {shares.length > 0 && (
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>
                                {t('session.sharing.sharedWith')}
                            </Text>
                            {shares.map(share => (
                                <ShareItem
                                    key={share.id}
                                    share={share}
                                    canManage={canManage}
                                    isSelected={selectedShareId === share.id}
                                    onPress={() => handleSharePress(share.id)}
                                    onAccessLevelChange={handleAccessLevelChange}
                                    onRemove={handleRemoveShare}
                                />
                            ))}
                        </View>
                    )}

                    {shares.length === 0 && !canManage && (
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyText}>
                                {t('session.sharing.noShares')}
                            </Text>
                        </View>
                    )}
                </ItemList>
            </ScrollView>
        </View>
    );
});

/**
 * Individual share item component
 */
interface ShareItemProps {
    share: SessionShare;
    canManage: boolean;
    isSelected: boolean;
    onPress: () => void;
    onAccessLevelChange: (shareId: string, accessLevel: ShareAccessLevel) => void;
    onRemove: (shareId: string) => void;
}

const ShareItem = memo(function ShareItem({
    share,
    canManage,
    isSelected,
    onPress,
    onAccessLevelChange,
    onRemove
}: ShareItemProps) {
    const accessLevelLabel = getAccessLevelLabel(share.accessLevel);
    const userName = share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName]
        .filter(Boolean)
        .join(' ');

    return (
        <View>
            <Item
                title={userName}
                subtitle={accessLevelLabel}
                icon={
                    <Avatar
                        id={share.sharedWithUser.id}
                        imageUrl={share.sharedWithUser.avatar}
                        size={32}
                    />
                }
                onPress={canManage ? onPress : undefined}
                showChevron={canManage}
            />

            {/* Access level options (shown when selected) */}
            {isSelected && canManage && (
                <View style={styles.options}>
                    <Item
                        title={t('session.sharing.viewOnly')}
                        subtitle={t('session.sharing.viewOnlyDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'view')}
                        selected={share.accessLevel === 'view'}
                    />
                    <Item
                        title={t('session.sharing.canEdit')}
                        subtitle={t('session.sharing.canEditDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'edit')}
                        selected={share.accessLevel === 'edit'}
                    />
                    <Item
                        title={t('session.sharing.canManage')}
                        subtitle={t('session.sharing.canManageDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'admin')}
                        selected={share.accessLevel === 'admin'}
                    />
                    <Item
                        title={t('session.sharing.stopSharing')}
                        onPress={() => onRemove(share.id)}
                        destructive
                    />
                </View>
            )}
        </View>
    );
});

/**
 * Get localized label for access level
 */
function getAccessLevelLabel(level: ShareAccessLevel): string {
    switch (level) {
        case 'view':
            return t('session.sharing.viewOnly');
        case 'edit':
            return t('session.sharing.canEdit');
        case 'admin':
            return t('session.sharing.canManage');
    }
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: 600,
        maxWidth: '90%',
        maxHeight: '80%',
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    content: {
        flex: 1,
    },
    section: {
        marginTop: 16,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        textTransform: 'uppercase',
    },
    options: {
        paddingLeft: 24,
        backgroundColor: theme.colors.surfaceHigh,
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));
