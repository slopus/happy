import React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends } from '@/sync/storage';
import { UserCard } from '@/components/UserCard';
import { removeFriend, sendFriendRequest } from '@/sync/apiFriends';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useRouter } from 'expo-router';

export default function FriendsScreen() {
    const { credentials } = useAuth();
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const [processingId, setProcessingId] = React.useState<string | null>(null);

    const [acceptLoading, doAccept] = useHappyAction(async () => {
        if (!credentials || !processingId) return;
        
        const fromUserId = processingId;
        // sendFriendRequest also accepts existing requests
        const updatedProfile = await sendFriendRequest(
            credentials,
            fromUserId
        );
        
        if (updatedProfile) {
            // Update local state immediately
            const updatedFriends = { ...storage.getState().friends };
            updatedFriends[fromUserId] = updatedProfile;
            storage.getState().applyFriends(Object.values(updatedFriends));
        }
        
        setProcessingId(null);
    });

    const [rejectLoading, doReject] = useHappyAction(async () => {
        if (!credentials || !processingId) return;
        
        const fromUserId = processingId;
        // Use removeFriend to reject requests
        await removeFriend(credentials, fromUserId);
        
        // Remove from local state immediately
        const updatedFriends = { ...storage.getState().friends };
        delete updatedFriends[fromUserId];
        storage.getState().applyFriends(Object.values(updatedFriends));
        
        setProcessingId(null);
    });

    const [removeLoading, doRemove] = useHappyAction(async () => {
        if (!credentials || !processingId) return;
        
        const friendId = processingId;
        const confirmed = await Modal.confirm(
            t('friends.confirmRemove'),
            t('friends.confirmRemoveMessage')
        );
        
        if (!confirmed) {
            setProcessingId(null);
            return;
        }
        
        await removeFriend(credentials, friendId);
        // Update will come through real-time sync
        setProcessingId(null);
    });

    const handleAcceptRequest = React.useCallback((fromUserId: string) => {
        setProcessingId(fromUserId);
        doAccept();
    }, [doAccept]);

    const handleRejectRequest = React.useCallback((fromUserId: string) => {
        setProcessingId(fromUserId);
        doReject();
    }, [doReject]);

    const handleRemoveFriend = React.useCallback((friendId: string) => {
        setProcessingId(friendId);
        doRemove();
    }, [doRemove]);

    const isProcessing = (id: string) => processingId === id && (acceptLoading || rejectLoading || removeLoading);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Friend Requests Section */}
            {friendRequests.length > 0 && (
                <ItemGroup
                    title={t('friends.pendingRequests')}
                    style={styles.groupStyle}
                >
                    {friendRequests.map((friend) => (
                        <UserCard
                            key={friend.id}
                            user={friend}
                            onPress={() => router.push(`/user/${friend.id}`)}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Sent Requests Section */}
            {requestedFriends.length > 0 && (
                <ItemGroup
                    title={t('friends.requestPending')}
                    style={styles.groupStyle}
                >
                    {requestedFriends.map((friend) => (
                        <UserCard
                            key={friend.id}
                            user={friend}
                            onPress={() => router.push(`/user/${friend.id}`)}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Friends List Section */}
            <ItemGroup
                title={
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>
                            {t('friends.myFriends')} ({friends.length})
                        </Text>
                    </View>
                }
                style={styles.groupStyle}
            >
                {friends.length === 0 ? (
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyText}>
                            {t('friends.noFriendsYet')}
                        </Text>
                    </View>
                ) : (
                    friends.map((friend) => (
                        <UserCard
                            key={friend.id}
                            user={friend}
                            onPress={() => router.push(`/user/${friend.id}`)}
                        />
                    ))
                )}
            </ItemGroup>
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    groupStyle: {
        marginBottom: 16,
    },
    sectionHeader: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    emptyState: {
        alignItems: 'center',
        padding: 32,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));