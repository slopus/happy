import * as React from 'react';
import { View, TextInput, Platform } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetFlatList, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { ShareAccessLevel } from '@/sync/sharingTypes';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

const SheetTextInput = Platform.OS === 'web' ? TextInput : BottomSheetTextInput;

export interface FriendSelectorProps {
    friends: UserProfile[];
    excludedUserIds: string[];
    onSelect: (userId: string, accessLevel: ShareAccessLevel) => void;
}

export const FriendSelector = React.memo(React.forwardRef<BottomSheetModal, FriendSelectorProps>(({
    friends,
    excludedUserIds,
    onSelect,
}, ref) => {
    const { theme } = useUnistyles();
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
    const [selectedAccessLevel, setSelectedAccessLevel] = React.useState<ShareAccessLevel>('view');

    const filteredFriends = React.useMemo(() => {
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

    const handleSelect = React.useCallback(() => {
        if (selectedUserId) {
            onSelect(selectedUserId, selectedAccessLevel);
            if (ref && typeof ref !== 'function' && ref.current) {
                ref.current.dismiss();
            }
        }
    }, [selectedUserId, selectedAccessLevel, onSelect, ref]);

    const handleAnimate = React.useCallback((_from: number, to: number) => {
        if (to === -1) {
            setSearchQuery('');
            setSelectedUserId(null);
            setSelectedAccessLevel('view');
        }
    }, []);

    const renderBackdrop = React.useCallback(
        (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
        [],
    );

    const renderItem = React.useCallback(({ item }: { item: UserProfile }) => {
        const hasKeys = !!item.contentPublicKey && !!item.contentPublicKeySig;
        const avatarUrl = item.avatar?.url || item.avatar?.path;
        const isSelected = selectedUserId === item.id;

        return (
            <View style={isSelected ? { backgroundColor: theme.colors.surfaceHigh } : undefined}>
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
                    iconContainerStyle={{ marginRight: 16 }}
                    onPress={hasKeys ? () => setSelectedUserId(item.id) : undefined}
                    disabled={!hasKeys}
                    showChevron={false}
                />
            </View>
        );
    }, [selectedUserId, theme]);

    const keyExtractor = React.useCallback((item: UserProfile) => item.id, []);

    const ListHeaderComponent = React.useMemo(() => (
        <View style={[styles.searchContainer, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
            <SheetTextInput
                style={[styles.searchInput, { color: theme.colors.text }, Platform.OS === 'web' && { outlineStyle: 'none' } as any]}
                placeholder={t('friends.searchPlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
            />
        </View>
    ), [searchQuery, theme]);

    const ListFooterComponent = React.useMemo(() => {
        if (!selectedUserId) return null;
        return (
            <View style={{ marginTop: 8 }}>
                <ItemGroup title={t('session.sharing.accessLevel')}>
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
                </ItemGroup>
                <ItemGroup>
                    <Item
                        title={t('session.sharing.addShare')}
                        onPress={handleSelect}
                    />
                </ItemGroup>
            </View>
        );
    }, [selectedUserId, selectedAccessLevel, handleSelect]);

    const ListEmptyComponent = React.useMemo(() => (
        <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                {searchQuery ? t('common.notFound') : t('friends.noFriendsYet')}
            </Text>
        </View>
    ), [searchQuery, theme]);

    return (
        <BottomSheetModal
            ref={ref}
            snapPoints={['75%']}
            enableDynamicSizing={false}
            keyboardBehavior="interactive"
            keyboardBlurBehavior="restore"
            android_keyboardInputMode="adjustResize"
            backdropComponent={renderBackdrop}
            onAnimate={handleAnimate}
            backgroundStyle={{ backgroundColor: theme.colors.groupped.background }}
            handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
        >
            <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: theme.colors.text }]}>
                    {t('session.sharing.shareWith')}
                </Text>
                <BottomSheetFlatList
                    data={filteredFriends}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    ListHeaderComponent={ListHeaderComponent}
                    ListFooterComponent={ListFooterComponent}
                    ListEmptyComponent={ListEmptyComponent}
                    contentContainerStyle={{ paddingBottom: 32 }}
                    keyboardShouldPersistTaps="handled"
                />
            </View>
        </BottomSheetModal>
    );
}));

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        textAlign: 'center',
        paddingVertical: 8,
    },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginVertical: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
    },
    searchInput: {
        ...Typography.default(),
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        padding: 0,
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 16,
        textAlign: 'center',
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
