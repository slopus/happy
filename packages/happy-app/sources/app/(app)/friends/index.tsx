import React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends } from '@/sync/storage';
import { UserCard } from '@/components/UserCard';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { useRouter } from 'expo-router';

export default function FriendsScreen() {
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();

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
                title={t('friends.myFriends')}
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
