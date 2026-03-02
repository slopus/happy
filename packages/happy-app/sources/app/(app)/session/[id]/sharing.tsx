import { memo, useState, useCallback, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSession, useIsDataReady } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { FriendSelector, SessionShareDialog } from '@/components/sessionSharing';
import { SessionShare, ShareAccessLevel } from '@/sync/sharingTypes';
import { getSessionShares, createSessionShare, updateSessionShare, deleteSessionShare } from '@/sync/apiSharing';
import { sync } from '@/sync/sync';
import { HappyError } from '@/utils/errors';
import { getFriendsList } from '@/sync/apiFriends';
import { UserProfile } from '@/sync/friendTypes';
import { encryptDataKeyForRecipientV0, verifyRecipientContentPublicKeyBinding } from '@/sync/directShareEncryption';

function SharingManagementContent({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);

    const [shares, setShares] = useState<SessionShare[]>([]);
    const [friends, setFriends] = useState<UserProfile[]>([]);
    const [showShareDialog, setShowShareDialog] = useState(false);
    const [showFriendSelector, setShowFriendSelector] = useState(false);

    // Load sharing data
    const loadSharingData = useCallback(async () => {
        const credentials = sync.getCredentials();
        const sharesData = await getSessionShares(credentials, sessionId);
        setShares(sharesData);
        const friendsData = await getFriendsList(credentials);
        setFriends(friendsData);
    }, [sessionId]);

    useEffect(() => {
        loadSharingData();
    }, [loadSharingData]);

    // Handle adding a new share
    const handleAddShare = useCallback(async (userId: string, accessLevel: ShareAccessLevel) => {
        const credentials = sync.getCredentials();

        const friend = friends.find(f => f.id === userId);
        if (!friend) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
        if (!friend.contentPublicKey || !friend.contentPublicKeySig) {
            throw new HappyError(t('session.sharing.recipientMissingKeys'), false);
        }
        const isValidBinding = verifyRecipientContentPublicKeyBinding({
            signingPublicKeyHex: friend.publicKey,
            contentPublicKeyB64: friend.contentPublicKey,
            contentPublicKeySigB64: friend.contentPublicKeySig,
        });
        if (!isValidBinding) {
            throw new HappyError(t('errors.operationFailed'), false);
        }

        // Get plaintext session DEK from the sync layer (owner/admin only)
        const dataKey = sync.getSessionDataKey(sessionId);
        if (!dataKey) {
            throw new HappyError(t('errors.sessionNotFound'), false);
        }
        const encryptedDataKey = encryptDataKeyForRecipientV0(dataKey, friend.contentPublicKey);

        await createSessionShare(credentials, sessionId, {
            userId,
            accessLevel,
            encryptedDataKey,
        });

        await loadSharingData();
        setShowFriendSelector(false);
    }, [friends, sessionId, loadSharingData]);

    // Handle updating share access level
    const handleUpdateShare = useCallback(async (shareId: string, accessLevel: ShareAccessLevel) => {
        const credentials = sync.getCredentials();
        await updateSessionShare(credentials, sessionId, shareId, accessLevel);
        await loadSharingData();
    }, [sessionId, loadSharingData]);

    // Handle removing a share
    const handleRemoveShare = useCallback(async (shareId: string) => {
        const credentials = sync.getCredentials();
        await deleteSessionShare(credentials, sessionId, shareId);
        await loadSharingData();
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
    const canManage = !session.accessLevel || session.accessLevel === 'admin';

    return (
        <>
            <ItemList>
                {/* Direct Sharing */}
                <ItemGroup title={t('session.sharing.directSharing')}>
                    {shares.length > 0 ? (
                        shares.map(share => (
                            <Item
                                key={share.id}
                                title={share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName].filter(Boolean).join(' ') || ''}
                                subtitle={`@${share.sharedWithUser.username} \u2022 ${t(`session.sharing.${share.accessLevel === 'view' ? 'viewOnly' : share.accessLevel === 'edit' ? 'canEdit' : 'canManage'}`)}`}
                                icon={<Ionicons name="person-outline" size={29} color="#007AFF" />}
                                onPress={() => setShowShareDialog(true)}
                            />
                        ))
                    ) : (
                        <Item
                            title={t('session.sharing.noShares')}
                            icon={<Ionicons name="people-outline" size={29} color="#8E8E93" />}
                            showChevron={false}
                        />
                    )}
                    {canManage && (
                        <Item
                            title={t('session.sharing.addShare')}
                            icon={<Ionicons name="person-add-outline" size={29} color="#34C759" />}
                            onPress={() => setShowFriendSelector(true)}
                        />
                    )}
                </ItemGroup>
            </ItemList>

            {/* Share Dialog */}
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
                    onClose={() => setShowShareDialog(false)}
                />
            )}

            {/* Friend Selector */}
            {showFriendSelector && (
                <FriendSelector
                    friends={friends}
                    excludedUserIds={excludedUserIds}
                    onSelect={handleAddShare}
                    onCancel={() => setShowFriendSelector(false)}
                />
            )}
        </>
    );
}

export default memo(function SharingScreen() {
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
