import React, { memo, useState, useCallback, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSession, useIsDataReady } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { SessionShareDialog } from '@/components/SessionSharing/SessionShareDialog';
import { FriendSelector } from '@/components/SessionSharing/FriendSelector';
import { PublicLinkDialog } from '@/components/SessionSharing/PublicLinkDialog';
import { SessionShare, PublicSessionShare, ShareAccessLevel } from '@/sync/sharingTypes';
import {
    getSessionShares,
    createSessionShare,
    updateSessionShare,
    deleteSessionShare,
    getPublicShare,
    createPublicShare,
    deletePublicShare
} from '@/sync/apiSharing';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { getFriendsList } from '@/sync/apiFriends';
import { UserProfile } from '@/sync/friendTypes';
import { encryptDataKeyForPublicShare } from '@/sync/publicShareEncryption';
import { getRandomBytes } from 'expo-crypto';

function SharingManagementContent({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const session = useSession(sessionId);

    const [shares, setShares] = useState<SessionShare[]>([]);
    const [publicShare, setPublicShare] = useState<PublicSessionShare | null>(null);
    const [friends, setFriends] = useState<UserProfile[]>([]);

    const [showShareDialog, setShowShareDialog] = useState(false);
    const [showFriendSelector, setShowFriendSelector] = useState(false);
    const [showPublicLinkDialog, setShowPublicLinkDialog] = useState(false);

    // Load sharing data
    const loadSharingData = useCallback(async () => {
        try {
            const credentials = sync.getCredentials();

            // Load shares
            const sharesData = await getSessionShares(credentials, sessionId);
            setShares(sharesData);

            // Load public share
            try {
                const publicShareData = await getPublicShare(credentials, sessionId);
                setPublicShare(publicShareData);
            } catch (e) {
                // No public share exists
                setPublicShare(null);
            }

            // Load friends list
            const friendsData = await getFriendsList(credentials);
            setFriends(friendsData.friends);
        } catch (error) {
            console.error('Failed to load sharing data:', error);
        }
    }, [sessionId]);

    useEffect(() => {
        loadSharingData();
    }, [loadSharingData]);

    // Handle adding a new share
    const handleAddShare = useCallback(async (userId: string, accessLevel: ShareAccessLevel) => {
        try {
            const credentials = sync.getCredentials();

            await createSessionShare(credentials, sessionId, {
                userId,
                accessLevel,
            });

            await loadSharingData();
            setShowFriendSelector(false);
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle updating share access level
    const handleUpdateShare = useCallback(async (shareId: string, accessLevel: ShareAccessLevel) => {
        try {
            const credentials = sync.getCredentials();
            await updateSessionShare(credentials, sessionId, shareId, accessLevel);
            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle removing a share
    const handleRemoveShare = useCallback(async (shareId: string) => {
        try {
            const credentials = sync.getCredentials();
            await deleteSessionShare(credentials, sessionId, shareId);
            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle creating public share
    const handleCreatePublicShare = useCallback(async (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => {
        try {
            const credentials = sync.getCredentials();

            // Generate random token (12 bytes = 24 hex chars)
            const tokenBytes = getRandomBytes(12);
            const token = Array.from(tokenBytes)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            // Get session data encryption key
            const dataKey = sync.getSessionDataKey(sessionId);
            if (!dataKey) {
                throw new HappyError(t('errors.sessionNotFound'), false);
            }

            // Encrypt data key with the token
            const encryptedDataKey = await encryptDataKeyForPublicShare(dataKey, token);

            const expiresAt = options.expiresInDays
                ? Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000
                : undefined;

            await createPublicShare(credentials, sessionId, {
                token,
                encryptedDataKey,
                expiresAt,
                maxUses: options.maxUses,
                isConsentRequired: options.isConsentRequired,
            });

            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle deleting public share
    const handleDeletePublicShare = useCallback(async () => {
        try {
            const credentials = sync.getCredentials();
            await deletePublicShare(credentials, sessionId);
            await loadSharingData();
            setShowPublicLinkDialog(false);
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{
                    color: theme.colors.text,
                    fontSize: 20,
                    marginTop: 16,
                    ...Typography.default('semiBold')
                }}>
                    {t('errors.sessionDeleted')}
                </Text>
            </View>
        );
    }

    const excludedUserIds = shares.map(share => share.sharedWithUser.id);
    // Check if current user is the session owner
    const currentUserId = sync.getUserID();
    const canManage = session.owner === currentUserId;

    return (
        <>
            <ItemList>
                {/* Current Shares */}
                <ItemGroup title={t('sessionSharing.directSharing')}>
                    {shares.length > 0 ? (
                        shares.map(share => (
                            <Item
                                key={share.id}
                                title={share.sharedWithUser.name || share.sharedWithUser.username}
                                subtitle={`@${share.sharedWithUser.username} • ${t(`sessionSharing.${share.accessLevel === 'view' ? 'viewOnly' : share.accessLevel === 'edit' ? 'canEdit' : 'canManage'}`)}`}
                                icon={<Ionicons name="person-outline" size={29} color="#007AFF" />}
                                onPress={() => setShowShareDialog(true)}
                            />
                        ))
                    ) : (
                        <Item
                            title={t('sessionSharing.noShares')}
                            icon={<Ionicons name="people-outline" size={29} color="#8E8E93" />}
                            showChevron={false}
                        />
                    )}
                    {canManage && (
                        <Item
                            title={t('sessionSharing.addShare')}
                            icon={<Ionicons name="person-add-outline" size={29} color="#34C759" />}
                            onPress={() => setShowFriendSelector(true)}
                        />
                    )}
                </ItemGroup>

                {/* Public Link */}
                <ItemGroup title={t('sessionSharing.publicLink')}>
                    {publicShare ? (
                        <Item
                            title={t('sessionSharing.publicLinkActive')}
                            subtitle={publicShare.expiresAt
                                ? t('sessionSharing.expiresOn') + ': ' + new Date(publicShare.expiresAt).toLocaleDateString()
                                : t('sessionSharing.never')
                            }
                            icon={<Ionicons name="link-outline" size={29} color="#34C759" />}
                            onPress={() => setShowPublicLinkDialog(true)}
                        />
                    ) : (
                        <Item
                            title={t('sessionSharing.createPublicLink')}
                            subtitle={t('sessionSharing.publicLinkDescription')}
                            icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                            onPress={() => setShowPublicLinkDialog(true)}
                        />
                    )}
                </ItemGroup>
            </ItemList>

            {/* Dialogs */}
            {showShareDialog && (
                <SessionShareDialog
                    sessionId={sessionId}
                    shares={shares}
                    canManage={canManage}
                    onAddShare={() => {
                        setShowShareDialog(false);
                        setShowFriendSelector(true);
                    }}
                    onUpdateShare={handleUpdateShare}
                    onRemoveShare={handleRemoveShare}
                    onManagePublicLink={() => {
                        setShowShareDialog(false);
                        setShowPublicLinkDialog(true);
                    }}
                    onClose={() => setShowShareDialog(false)}
                />
            )}

            {showFriendSelector && (
                <FriendSelector
                    friends={friends}
                    excludedUserIds={excludedUserIds}
                    onSelect={handleAddShare}
                    onCancel={() => setShowFriendSelector(false)}
                />
            )}

            {showPublicLinkDialog && (
                <PublicLinkDialog
                    publicShare={publicShare}
                    onCreate={handleCreatePublicShare}
                    onDelete={handleDeletePublicShare}
                    onCancel={() => setShowPublicLinkDialog(false)}
                />
            )}
        </>
    );
}

export default memo(() => {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const isDataReady = useIsDataReady();

    if (!isDataReady) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="hourglass-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{
                    color: theme.colors.textSecondary,
                    fontSize: 17,
                    marginTop: 16,
                    ...Typography.default('semiBold')
                }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    return <SharingManagementContent sessionId={id} />;
});
