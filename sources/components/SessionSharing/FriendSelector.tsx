import React, { memo, useState, useMemo } from 'react';
import { View, Text, TextInput, FlatList } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { ShareAccessLevel } from '@/sync/sharingTypes';
import { UserCard } from '@/components/UserCard';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { CustomModal } from '@/components/CustomModal';

/**
 * Props for FriendSelector component
 */
export interface FriendSelectorProps {
    /** List of friends to choose from */
    friends: UserProfile[];
    /** IDs of users already having access */
    excludedUserIds: string[];
    /** Callback when a friend is selected */
    onSelect: (userId: string, accessLevel: ShareAccessLevel) => void;
    /** Callback when cancelled */
    onCancel: () => void;
}

/**
 * Modal for selecting a friend to share with
 *
 * @remarks
 * Displays a searchable list of friends and allows selecting
 * an access level before confirming the share.
 */
export const FriendSelector = memo(function FriendSelector({
    friends,
    excludedUserIds,
    onSelect,
    onCancel
}: FriendSelectorProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
    const [selectedAccessLevel, setSelectedAccessLevel] = useState<ShareAccessLevel>('view');

    // Filter friends based on search and exclusions
    const filteredFriends = useMemo(() => {
        const excluded = new Set(excludedUserIds);
        return friends.filter(friend => {
            if (excluded.has(friend.id)) return false;
            if (!searchQuery) return true;

            const displayName = getDisplayName(friend).toLowerCase();
            const username = friend.username.toLowerCase();
            const query = searchQuery.toLowerCase();

            return displayName.includes(query) || username.includes(query);
        });
    }, [friends, excludedUserIds, searchQuery]);

    const handleConfirm = () => {
        if (selectedUserId) {
            onSelect(selectedUserId, selectedAccessLevel);
        }
    };

    const selectedFriend = useMemo(() => {
        return friends.find(f => f.id === selectedUserId);
    }, [friends, selectedUserId]);

    return (
        <CustomModal
            visible={true}
            onClose={onCancel}
            title={t('sessionSharing.addShare')}
            buttons={[
                {
                    title: t('common.cancel'),
                    style: 'cancel',
                    onPress: onCancel
                },
                {
                    title: t('common.add'),
                    style: 'default',
                    onPress: handleConfirm,
                    disabled: !selectedUserId
                }
            ]}
        >
            <View style={styles.container}>
                {/* Search input */}
                <TextInput
                    style={styles.searchInput}
                    placeholder={t('friends.searchFriends')}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    autoFocus
                />

                {/* Friend list */}
                <View style={styles.friendList}>
                    <FlatList
                        data={filteredFriends}
                        keyExtractor={(item) => item.id}
                        renderItem={({ item }) => (
                            <View style={styles.friendItem}>
                                <UserCard
                                    user={item}
                                    onPress={() => setSelectedUserId(item.id)}
                                />
                                {selectedUserId === item.id && (
                                    <View style={styles.selectedIndicator} />
                                )}
                            </View>
                        )}
                        ListEmptyComponent={
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyText}>
                                    {searchQuery
                                        ? t('friends.noFriendsFound')
                                        : t('friends.noFriendsYet')
                                    }
                                </Text>
                            </View>
                        }
                    />
                </View>

                {/* Access level selection (only shown when friend is selected) */}
                {selectedFriend && (
                    <View style={styles.accessLevelSection}>
                        <Text style={styles.sectionTitle}>
                            {t('sessionSharing.accessLevel')}
                        </Text>
                        <Item
                            title={t('sessionSharing.viewOnly')}
                            subtitle={t('sessionSharing.viewOnlyDescription')}
                            onPress={() => setSelectedAccessLevel('view')}
                            rightElement={
                                selectedAccessLevel === 'view' ? (
                                    <View style={styles.radioSelected} />
                                ) : (
                                    <View style={styles.radioUnselected} />
                                )
                            }
                        />
                        <Item
                            title={t('sessionSharing.canEdit')}
                            subtitle={t('sessionSharing.canEditDescription')}
                            onPress={() => setSelectedAccessLevel('edit')}
                            rightElement={
                                selectedAccessLevel === 'edit' ? (
                                    <View style={styles.radioSelected} />
                                ) : (
                                    <View style={styles.radioUnselected} />
                                )
                            }
                        />
                        <Item
                            title={t('sessionSharing.canManage')}
                            subtitle={t('sessionSharing.canManageDescription')}
                            onPress={() => setSelectedAccessLevel('admin')}
                            rightElement={
                                selectedAccessLevel === 'admin' ? (
                                    <View style={styles.radioSelected} />
                                ) : (
                                    <View style={styles.radioUnselected} />
                                )
                            }
                        />
                    </View>
                )}
            </View>
        </CustomModal>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 400,
        maxHeight: 600,
    },
    searchInput: {
        height: 40,
        borderRadius: 8,
        backgroundColor: theme.colors.backgroundSecondary,
        paddingHorizontal: 12,
        marginBottom: 16,
        fontSize: 16,
        color: theme.colors.typography,
    },
    friendList: {
        flex: 1,
        marginBottom: 16,
    },
    friendItem: {
        position: 'relative',
    },
    selectedIndicator: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        backgroundColor: theme.colors.primary,
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
    accessLevelSection: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 16,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.typography,
        marginBottom: 12,
    },
    radioSelected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.primary,
        borderWidth: 2,
        borderColor: theme.colors.primary,
    },
    radioUnselected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
    },
}));
