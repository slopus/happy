import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends, useFeedItems, useFeedLoaded, useFriendsLoaded, useRealtimeStatus } from '@/sync/storage';
import { UserCard } from '@/components/UserCard';
import { t } from '@/text';
import { trackFriendsSearch, trackFriendsProfileView } from '@/track';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { UpdateBanner } from './UpdateBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { layout } from '@/components/layout';
import { useIsTablet } from '@/utils/responsive';
import { Header } from './navigation/Header';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { FeedItemCard } from './FeedItemCard';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyDescription: {
        fontSize: 16,
        ...Typography.default(),
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
    },
    sectionHeader: {
        fontSize: 14,
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingTop: 24,
        paddingBottom: 8,
        textTransform: 'uppercase',
    },
}));

interface InboxViewProps {
}

// Header components for tablet mode only (phone mode header is in MainView)
function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.header.tint,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            {t('tabs.inbox')}
        </Text>
    );
}

function HeaderRightTablet() {
    const router = useRouter();
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={() => {
                trackFriendsSearch();
                router.push('/friends/search');
            }}
            hitSlop={15}
            style={{
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Ionicons name="person-add-outline" size={24} color={theme.colors.header.tint} />
        </Pressable>
    );
}

export const InboxView = React.memo(({}: InboxViewProps) => {
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const feedLoaded = useFeedLoaded();
    const friendsLoaded = useFriendsLoaded();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();

    const isLoading = !feedLoaded || !friendsLoaded;
    const isEmpty = !isLoading && friendRequests.length === 0 && requestedFriends.length === 0 && friends.length === 0 && feedItems.length === 0;

    if (isLoading) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.groupped.background }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => <HeaderRightTablet />}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                        {realtimeStatus !== 'disconnected' && (
                            <VoiceAssistantStatusBar variant="full" />
                        )}
                    </View>
                )}
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            </View>
        );
    }

    if (isEmpty) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.groupped.background }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => <HeaderRightTablet />}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                        {realtimeStatus !== 'disconnected' && (
                            <VoiceAssistantStatusBar variant="full" />
                        )}
                    </View>
                )}
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <Image
                        source={require('@/assets/images/brutalist/Brutalism 10.png')}
                        contentFit="contain"
                        style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                        tintColor={theme.colors.textSecondary}
                    />
                    <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('inbox.emptyDescription')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {isTablet && (
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <Header
                        title={<HeaderTitleTablet />}
                        headerRight={() => <HeaderRightTablet />}
                        headerLeft={() => null}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                    {realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%'
            }}>
                <UpdateBanner />
                
                {feedItems.length > 0 && (
                    <>
                        <ItemGroup title={t('inbox.updates')}>
                            {feedItems.map((item) => (
                                <FeedItemCard
                                    key={item.id}
                                    item={item}
                                />
                            ))}
                        </ItemGroup>
                    </>
                )}
                
                {friendRequests.length > 0 && (
                    <>
                        <ItemGroup title={t('friends.pendingRequests')}>
                            {friendRequests.map((friend) => (
                                <UserCard
                                    key={friend.id}
                                    user={friend}
                                    onPress={() => {
                                        trackFriendsProfileView();
                                        router.push(`/user/${friend.id}`);
                                    }}
                                />
                            ))}
                        </ItemGroup>
                    </>
                )}

                {requestedFriends.length > 0 && (
                    <>
                        <ItemGroup title={t('friends.requestPending')}>
                            {requestedFriends.map((friend) => (
                                <UserCard
                                    key={friend.id}
                                    user={friend}
                                    onPress={() => {
                                        trackFriendsProfileView();
                                        router.push(`/user/${friend.id}`);
                                    }}
                                />
                            ))}
                        </ItemGroup>
                    </>
                )}

                {friends.length > 0 && (
                    <>
                        <ItemGroup title={t('friends.myFriends')}>
                            {friends.map((friend) => (
                                <UserCard
                                    key={friend.id}
                                    user={friend}
                                    onPress={() => {
                                        trackFriendsProfileView();
                                        router.push(`/user/${friend.id}`);
                                    }}
                                />
                            ))}
                        </ItemGroup>
                    </>
                )}
            </ScrollView>
        </View>
    );
});