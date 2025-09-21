import * as React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends, useSocketStatus } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { UserCard } from '@/components/UserCard';
import { t } from '@/text';
import { ItemGroup } from '@/components/ItemGroup';
import { UpdateBanner } from './UpdateBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { layout } from '@/components/layout';
import { useIsTablet } from '@/utils/responsive';
import { Header } from './navigation/Header';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';

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

function HeaderTitle() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    isPulsing: false,
                    text: t('status.connected'),
                    textColor: theme.colors.status.connected
                };
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: theme.colors.status.connecting
                };
            case 'disconnected':
                return {
                    color: theme.colors.status.disconnected,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: theme.colors.status.disconnected
                };
            case 'error':
                return {
                    color: theme.colors.status.error,
                    isPulsing: false,
                    text: t('status.error'),
                    textColor: theme.colors.status.error
                };
            default:
                return {
                    color: theme.colors.status.default,
                    isPulsing: false,
                    text: '',
                    textColor: theme.colors.status.default
                };
        }
    };

    const connectionStatus = getConnectionStatus();
    
    return (
        <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{
                fontSize: 17,
                color: theme.colors.header.tint,
                fontWeight: '600',
                ...Typography.default('semiBold'),
            }}>
                {t('tabs.inbox')}
            </Text>
            {connectionStatus.text && (
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: -2,
                }}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text style={{
                        fontSize: 12,
                        fontWeight: '500',
                        lineHeight: 16,
                        color: connectionStatus.textColor,
                        ...Typography.default(),
                    }}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}

function HeaderLeft() {
    const { theme } = useUnistyles();
    return (
        <View style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <Image
                source={require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={[{ width: 24, height: 24 }]}
                tintColor={theme.colors.header.tint}
            />
        </View>
    );
}

function HeaderRight() {
    const router = useRouter();
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={() => router.push('/friends/search')}
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

// Simplified header components for tablet
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

export const InboxView = React.memo(({}: InboxViewProps) => {
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();

    const isEmpty = friendRequests.length === 0 && requestedFriends.length === 0 && friends.length === 0;

    if (isEmpty) {
        return (
            <View style={styles.container}>
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <Header
                        title={isTablet ? <HeaderTitleTablet /> : <HeaderTitle />}
                        headerRight={() => <HeaderRight />}
                        headerLeft={isTablet ? () => null : () => <HeaderLeft />}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                </View>
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
            <View style={{ backgroundColor: theme.colors.groupped.background }}>
                <Header
                    title={isTablet ? <HeaderTitleTablet /> : <HeaderTitle />}
                    headerRight={() => <HeaderRight />}
                    headerLeft={isTablet ? () => null : () => <HeaderLeft />}
                    headerShadowVisible={false}
                    headerTransparent={true}
                />
            </View>
            <ScrollView contentContainerStyle={{ 
                maxWidth: layout.maxWidth, 
                alignSelf: 'center', 
                width: '100%'
            }}>
                <UpdateBanner />
                
                {friendRequests.length > 0 && (
                    <>
                        <ItemGroup title={t('friends.pendingRequests')}>
                            {friendRequests.map((friend) => (
                                <UserCard
                                    key={friend.id}
                                    user={friend}
                                    onPress={() => router.push(`/user/${friend.id}`)}
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
                                    onPress={() => router.push(`/user/${friend.id}`)}
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
                                    onPress={() => router.push(`/user/${friend.id}`)}
                                />
                            ))}
                        </ItemGroup>
                    </>
                )}
            </ScrollView>
        </View>
    );
});