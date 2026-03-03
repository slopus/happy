import { memo, useState, useMemo } from 'react';
import { View, Text, TextInput, FlatList, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { ShareAccessLevel } from '@/sync/sharingTypes';
import { Item } from '@/components/Item';
import { Avatar } from '@/components/Avatar';
import { t } from '@/text';

/**
 * Props for FriendSelector component
 */
export interface FriendSelectorProps {
    /** List of friends to choose from */
    friends: UserProfile[];
    /** IDs of users already having access */
    excludedUserIds: string[];
    /** Callback when a friend is selected with an access level */
    onSelect: (userId: string, accessLevel: ShareAccessLevel) => void;
    /** Callback when user cancels selection */
    onCancel: () => void;
}

/**
 * Friend selector component for sharing
 *
 * Displays a searchable list of friends and allows selecting
 * an access level. Filters out excluded users and friends
 * without encryption keys.
 */
export const FriendSelector = memo(function FriendSelector({
    friends,
    excludedUserIds,
    onSelect,
    onCancel,
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

    const selectedFriend = useMemo(() => {
        return friends.find(f => f.id === selectedUserId);
    }, [friends, selectedUserId]);

    return (
        <ScrollView style={styles.container}>
            {/* Search input */}
            <TextInput
                style={styles.searchInput}
                placeholder={t('friends.searchPlaceholder')}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
            />

            {/* Friend list */}
            <View style={styles.friendList}>
                <FlatList
                    data={filteredFriends}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => {
                        const hasKeys = !!item.contentPublicKey && !!item.contentPublicKeySig;
                        const avatarUrl = item.avatar?.url || item.avatar?.path;

                        return (
                            <View style={styles.friendItem}>
                                <Item
                                    title={getDisplayName(item)}
                                    subtitle={hasKeys ? `@${item.username}` : t('session.sharing.recipientMissingKeys')}
                                    subtitleLines={1}
                                    leftElement={
                                        <Avatar
                                            id={item.id}
                                            size={40}
                                            imageUrl={avatarUrl}
                                            thumbhash={item.avatar?.thumbhash}
                                        />
                                    }
                                    onPress={hasKeys ? () => setSelectedUserId(item.id) : undefined}
                                    disabled={!hasKeys}
                                    showChevron={false}
                                />
                                {selectedUserId === item.id && (
                                    <View style={styles.selectedIndicator} />
                                )}
                            </View>
                        );
                    }}
                    ListEmptyComponent={
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyText}>
                                {searchQuery
                                    ? t('common.notFound')
                                    : t('friends.noFriendsYet')
                                }
                            </Text>
                        </View>
                    }
                    scrollEnabled={false}
                />
            </View>

            {/* Access level selection (only shown when friend is selected) */}
            {selectedFriend && (
                <View style={styles.accessLevelSection}>
                    <Text style={styles.sectionTitle}>
                        {t('session.sharing.accessLevel')}
                    </Text>
                    <Item
                        title={t('session.sharing.viewOnly')}
                        subtitle={t('session.sharing.viewOnlyDescription')}
                        onPress={() => setSelectedAccessLevel('view')}
                        rightElement={
                            selectedAccessLevel === 'view' ? (
                                <View style={styles.radioSelected}>
                                    <View style={styles.radioDot} />
                                </View>
                            ) : (
                                <View style={styles.radioUnselected} />
                            )
                        }
                    />
                    <Item
                        title={t('session.sharing.canEdit')}
                        subtitle={t('session.sharing.canEditDescription')}
                        onPress={() => setSelectedAccessLevel('edit')}
                        rightElement={
                            selectedAccessLevel === 'edit' ? (
                                <View style={styles.radioSelected}>
                                    <View style={styles.radioDot} />
                                </View>
                            ) : (
                                <View style={styles.radioUnselected} />
                            )
                        }
                    />
                    <Item
                        title={t('session.sharing.canManage')}
                        subtitle={t('session.sharing.canManageDescription')}
                        onPress={() => setSelectedAccessLevel('admin')}
                        rightElement={
                            selectedAccessLevel === 'admin' ? (
                                <View style={styles.radioSelected}>
                                    <View style={styles.radioDot} />
                                </View>
                            ) : (
                                <View style={styles.radioUnselected} />
                            )
                        }
                    />
                    <View style={styles.buttonRow}>
                        <Item
                            title={t('common.cancel')}
                            onPress={onCancel}
                        />
                        <Item
                            title={t('session.sharing.addShare')}
                            onPress={() => onSelect(selectedUserId!, selectedAccessLevel)}
                        />
                    </View>
                </View>
            )}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        padding: 16,
    },
    searchInput: {
        height: 40,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 12,
        marginBottom: 16,
        fontSize: 16,
        color: theme.colors.text,
    },
    friendList: {
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
        backgroundColor: theme.colors.textLink,
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
        marginTop: 8,
    },
    sectionTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 12,
        paddingHorizontal: 4,
    },
    buttonRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        marginTop: 16,
        gap: 8,
    },
    radioSelected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: theme.colors.radio.active,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    radioUnselected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.radio.inactive,
    },
}));
