import { memo, useRef, useState, useCallback, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSession, useIsDataReady } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { FriendSelector, SessionShareDialog, PublicLinkDialog } from '@/components/sessionSharing';
import { SessionShare, ShareAccessLevel, PublicSessionShare } from '@/sync/sharingTypes';
import { getSessionShares, createSessionShare, updateSessionShare, deleteSessionShare, getPublicShare, createPublicShare, deletePublicShare } from '@/sync/apiSharing';
import { sync } from '@/sync/sync';
import { HappyError } from '@/utils/errors';
import { getFriendsList } from '@/sync/apiFriends';
import { UserProfile } from '@/sync/friendTypes';
import { encryptDataKeyForRecipientV0, verifyRecipientContentPublicKeyBinding } from '@/sync/directShareEncryption';
import { encryptDataKeyForPublicShare } from '@/sync/encryption/publicShareEncryption';
import { getRandomBytes } from 'expo-crypto';
import { getServerUrl } from '@/sync/serverConfig';
import { Modal } from '@/modal';

function SharingManagementContent({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);

    const [shares, setShares] = useState<SessionShare[]>([]);
    const [friends, setFriends] = useState<UserProfile[]>([]);
    const [publicShare, setPublicShare] = useState<PublicSessionShare | null>(null);
    const [publicShareToken, setPublicShareToken] = useState<string | null>(null);

    const shareDialogRef = useRef<BottomSheetModal>(null);
    const friendSelectorRef = useRef<BottomSheetModal>(null);
    const publicLinkRef = useRef<BottomSheetModal>(null);

    // Load sharing data
    const loadSharingData = useCallback(async () => {
        const credentials = sync.getCredentials();
        const sharesData = await getSessionShares(credentials, sessionId);
        setShares(sharesData);
        const friendsData = await getFriendsList(credentials);
        setFriends(friendsData);
        try {
            const publicShareData = await getPublicShare(credentials, sessionId);
            setPublicShare(publicShareData);
        } catch {
            setPublicShare(null);
        }
    }, [sessionId]);

    useEffect(() => {
        loadSharingData();
    }, [loadSharingData]);

    // Handle adding a new share
    const handleAddShare = useCallback(async (userId: string, accessLevel: ShareAccessLevel) => {
        try {
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
        } catch (e) {
            Modal.alert('Error', e instanceof HappyError ? e.message : t('errors.operationFailed'), [{ text: 'OK', style: 'cancel' }]);
        }
    }, [friends, sessionId, loadSharingData]);

    // Handle updating share access level
    const handleUpdateShare = useCallback(async (shareId: string, accessLevel: ShareAccessLevel) => {
        try {
            const credentials = sync.getCredentials();
            await updateSessionShare(credentials, sessionId, shareId, accessLevel);
            await loadSharingData();
        } catch (e) {
            Modal.alert('Error', e instanceof HappyError ? e.message : t('errors.operationFailed'), [{ text: 'OK', style: 'cancel' }]);
        }
    }, [sessionId, loadSharingData]);

    // Handle removing a share
    const handleRemoveShare = useCallback(async (shareId: string) => {
        try {
            const credentials = sync.getCredentials();
            await deleteSessionShare(credentials, sessionId, shareId);
            await loadSharingData();
        } catch (e) {
            Modal.alert('Error', e instanceof HappyError ? e.message : t('errors.operationFailed'), [{ text: 'OK', style: 'cancel' }]);
        }
    }, [sessionId, loadSharingData]);

    // Handle creating a public share
    const handleCreatePublicShare = useCallback(async (options: { expiresInDays?: number; maxUses?: number; isConsentRequired: boolean }) => {
        try {
            const credentials = sync.getCredentials();
            const tokenBytes = getRandomBytes(12);
            const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const dataKey = sync.getSessionDataKey(sessionId);
            if (!dataKey) throw new HappyError(t('errors.sessionNotFound'), false);
            const encryptedDataKey = await encryptDataKeyForPublicShare(dataKey, token);
            const expiresAt = options.expiresInDays ? Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000 : undefined;
            const created = await createPublicShare(credentials, sessionId, {
                token, encryptedDataKey, expiresAt, maxUses: options.maxUses, isConsentRequired: options.isConsentRequired,
            });
            setPublicShare(created);
            setPublicShareToken(token);
            await loadSharingData();
        } catch (e) {
            Modal.alert('Error', e instanceof HappyError ? e.message : t('errors.operationFailed'), [{ text: 'OK', style: 'cancel' }]);
        }
    }, [sessionId, loadSharingData]);

    // Handle deleting a public share
    const handleDeletePublicShare = useCallback(async () => {
        try {
            const credentials = sync.getCredentials();
            await deletePublicShare(credentials, sessionId);
            setPublicShare(null);
            setPublicShareToken(null);
            await loadSharingData();
        } catch (e) {
            Modal.alert('Error', e instanceof HappyError ? e.message : t('errors.operationFailed'), [{ text: 'OK', style: 'cancel' }]);
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
    const canManage = !session.accessLevel || session.accessLevel === 'admin';
    const effectiveToken = publicShareToken || publicShare?.token;
    const publicShareUrl = effectiveToken ? `${getServerUrl()}/v1/public-share/${effectiveToken}` : null;

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
                                onPress={() => shareDialogRef.current?.present()}
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
                            onPress={() => friendSelectorRef.current?.present()}
                        />
                    )}
                </ItemGroup>

                {/* Public Link */}
                <ItemGroup title={t('session.sharing.publicLink')}>
                    {publicShare ? (
                        <Item
                            title={t('session.sharing.publicLinkActive')}
                            subtitle={publicShare.expiresAt
                                ? t('session.sharing.expiresOn') + ': ' + new Date(publicShare.expiresAt).toLocaleDateString()
                                : t('session.sharing.never')
                            }
                            icon={<Ionicons name="link-outline" size={29} color="#34C759" />}
                            onPress={() => publicLinkRef.current?.present()}
                        />
                    ) : (
                        <Item
                            title={t('session.sharing.createPublicLink')}
                            subtitle={t('session.sharing.publicLinkDescription')}
                            icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                            onPress={() => publicLinkRef.current?.present()}
                        />
                    )}
                </ItemGroup>
            </ItemList>

            {/* Bottom Sheets */}
            <SessionShareDialog
                ref={shareDialogRef}
                sessionId={sessionId}
                shares={shares}
                canManage={canManage}
                onAddShare={() => friendSelectorRef.current?.present()}
                onUpdateShare={handleUpdateShare}
                onRemoveShare={handleRemoveShare}
            />

            <FriendSelector
                ref={friendSelectorRef}
                friends={friends}
                excludedUserIds={excludedUserIds}
                onSelect={handleAddShare}
            />

            <PublicLinkDialog
                ref={publicLinkRef}
                publicShare={publicShare}
                publicShareUrl={publicShareUrl}
                onCreate={handleCreatePublicShare}
                onDelete={handleDeletePublicShare}
            />
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
