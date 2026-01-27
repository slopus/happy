import React, { memo, useState, useMemo } from 'react';
import { View, Text, TextInput, FlatList, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { ShareAccessLevel } from '@/sync/sharingTypes';
import { UserCard } from '@/components/UserCard';
import { Item } from '@/components/Item';
import { t } from '@/text';

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
    /** Currently selected user ID (optional) */
    selectedUserId?: string | null;
    /** Currently selected access level (optional) */
    selectedAccessLevel?: ShareAccessLevel;
}

/**
 * Friend selector component for sharing
 *
 * @remarks
 * Displays a searchable list of friends and allows selecting
 * an access level. This is a controlled component - parent
 * manages the modal and button states.
 */
export const FriendSelector = memo(function FriendSelector({
    friends,
    excludedUserIds,
    onSelect,
    selectedUserId: initialSelectedUserId = null,
    selectedAccessLevel: initialSelectedAccessLevel = 'view',
}: FriendSelectorProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedUserId, setSelectedUserId] = useState<string | null>(initialSelectedUserId);
    const [selectedAccessLevel, setSelectedAccessLevel] = useState<ShareAccessLevel>(initialSelectedAccessLevel);

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

    // Call onSelect when both user and access level are chosen
    React.useEffect(() => {
        if (selectedUserId && selectedAccessLevel) {
            onSelect(selectedUserId, selectedAccessLevel);
        }
    }, [selectedUserId, selectedAccessLevel, onSelect]);

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
                    renderItem={({ item }) => (
                        <View style={styles.friendItem}>
                            <UserCard
                                user={item}
                                onPress={item.contentPublicKey && item.contentPublicKeySig ? () => setSelectedUserId(item.id) : undefined}
                                disabled={!item.contentPublicKey || !item.contentPublicKeySig}
                                subtitle={!item.contentPublicKey || !item.contentPublicKeySig ? t('session.sharing.recipientMissingKeys') : undefined}
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
                                    ? t('common.noMatches')
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
