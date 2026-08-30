import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends, useFeedItems, useFeedLoaded, useFriendsLoaded, useRealtimeStatus } from '@/sync/storage';
import { UserCard } from '@/components/UserCard';
import { t } from '@/text';
import { trackFriendsSearch, trackFriendsProfileView } from '@/track';
import { ItemGroup } from '@/components/ItemGroup';
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
import { useCodexAttachCandidateInbox } from '@/hooks/useCodexAttachCandidateInbox';
import type { MachineCodexAttachCandidate } from '@/sync/codexAttachCandidates';
import { formatLastSeen } from '@/utils/sessionUtils';
import { Modal } from '@/modal';
import { filterCodexAttachCandidates } from '@/sync/filterCodexAttachCandidates';

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
    candidateIntro: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        paddingHorizontal: 16,
        paddingBottom: 10,
        ...Typography.default(),
    },
    candidateSearch: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 10,
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
        marginHorizontal: 16,
        minHeight: 44,
        paddingHorizontal: 12,
    },
    candidateSearchInput: {
        color: theme.colors.text,
        flex: 1,
        fontSize: 14,
        paddingVertical: 10,
        ...Typography.default(),
    },
    candidateSearchEmpty: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        paddingBottom: 18,
        paddingHorizontal: 16,
        textAlign: 'center',
        ...Typography.default(),
    },
    candidateCard: {
        backgroundColor: theme.colors.surface,
        borderBottomColor: theme.colors.divider,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    candidateHeader: {
        alignItems: 'flex-start',
        flexDirection: 'row',
        gap: 10,
    },
    candidateIcon: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 9,
        height: 36,
        justifyContent: 'center',
        width: 36,
    },
    candidateCopy: { flex: 1, minWidth: 0 },
    candidateTitle: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default('semiBold'),
    },
    candidateMeta: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 3,
        ...Typography.default(),
    },
    candidateActions: {
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'flex-end',
        marginTop: 12,
    },
    candidateButton: {
        alignItems: 'center',
        borderRadius: 9,
        justifyContent: 'center',
        minHeight: 40,
        minWidth: 76,
        paddingHorizontal: 14,
    },
    candidateButtonPrimary: { backgroundColor: theme.colors.button.primary.background },
    candidateButtonSecondary: { backgroundColor: theme.colors.surfaceHigh },
    candidateButtonPressed: { opacity: 0.72 },
    candidateButtonText: { color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    candidateButtonTextPrimary: { color: theme.colors.button.primary.tint },
    candidateError: {
        color: theme.colors.status.error,
        fontSize: 13,
        lineHeight: 18,
        paddingHorizontal: 16,
        paddingVertical: 12,
        ...Typography.default(),
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
            accessibilityLabel={t('friends.addFriend')}
            accessibilityRole="button"
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
    const candidateInbox = useCodexAttachCandidateInbox();
    const [candidateQuery, setCandidateQuery] = React.useState('');
    const filteredCandidates = React.useMemo(
        () => filterCodexAttachCandidates(candidateInbox.candidates, candidateQuery),
        [candidateInbox.candidates, candidateQuery],
    );

    const isLoading = !feedLoaded || !friendsLoaded || candidateInbox.loading;
    const isEmpty = !isLoading
        && !candidateInbox.error
        && candidateInbox.candidates.length === 0
        && friendRequests.length === 0
        && requestedFriends.length === 0
        && friends.length === 0
        && feedItems.length === 0;

    const attachCandidate = React.useCallback(async (candidate: MachineCodexAttachCandidate) => {
        try {
            const sessionId = await candidateInbox.attach(candidate);
            router.push(`/session/${sessionId}`);
        } catch {
            Modal.alert(t('common.error'), t('inbox.candidateUnavailable'));
        }
    }, [candidateInbox.attach, router]);

    const dismissCandidate = React.useCallback(async (candidate: MachineCodexAttachCandidate) => {
        try {
            await candidateInbox.dismiss(candidate);
        } catch {
            Modal.alert(t('common.error'), t('inbox.candidateUnavailable'));
        }
    }, [candidateInbox.dismiss]);

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
                        source={require('@/assets/images/brutalist/Brutalism-10.png')}
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

                {(candidateInbox.candidates.length > 0 || candidateInbox.error) && (
                    <ItemGroup title={t('inbox.codexCandidates')}>
                        <Text style={styles.candidateIntro}>{t('inbox.codexCandidateDescription')}</Text>
                        {candidateInbox.candidates.length > 0 ? (
                            <View style={styles.candidateSearch}>
                                <Ionicons name="search-outline" size={18} color={theme.colors.textSecondary} />
                                <TextInput
                                    accessibilityLabel={t('inbox.searchCodexCandidatesPlaceholder')}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    clearButtonMode="while-editing"
                                    onChangeText={setCandidateQuery}
                                    placeholder={t('inbox.searchCodexCandidatesPlaceholder')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    style={styles.candidateSearchInput}
                                    value={candidateQuery}
                                />
                            </View>
                        ) : null}
                        {candidateInbox.error ? (
                            <Text style={styles.candidateError}>{t('inbox.candidateUnavailable')}</Text>
                        ) : null}
                        {!candidateInbox.error && candidateQuery.trim() && filteredCandidates.length === 0 ? (
                            <Text style={styles.candidateSearchEmpty}>{t('inbox.noCodexCandidatesFound')}</Text>
                        ) : null}
                        {filteredCandidates.map((candidate) => {
                            const busy = candidateInbox.busyThreadId === candidate.threadId;
                            return (
                                <View key={`${candidate.machineId}:${candidate.threadId}`} style={styles.candidateCard}>
                                    <View style={styles.candidateHeader}>
                                        <View style={styles.candidateIcon}>
                                            <Ionicons name="desktop-outline" size={20} color={theme.colors.textSecondary} />
                                        </View>
                                        <View style={styles.candidateCopy}>
                                            <Text style={styles.candidateTitle} numberOfLines={2}>{candidate.title}</Text>
                                            <Text style={styles.candidateMeta} numberOfLines={1}>{candidate.directory}</Text>
                                            <Text style={styles.candidateMeta} numberOfLines={1}>
                                                {candidate.machineName} · {formatLastSeen(candidate.updatedAt, false)}
                                            </Text>
                                        </View>
                                    </View>
                                    <View style={styles.candidateActions}>
                                        <Pressable
                                            accessibilityRole="button"
                                            disabled={busy}
                                            onPress={() => void dismissCandidate(candidate)}
                                            style={({ pressed }) => [
                                                styles.candidateButton,
                                                styles.candidateButtonSecondary,
                                                pressed && styles.candidateButtonPressed,
                                            ]}
                                        >
                                            <Text style={styles.candidateButtonText}>{t('inbox.dismissCandidate')}</Text>
                                        </Pressable>
                                        <Pressable
                                            accessibilityRole="button"
                                            disabled={busy}
                                            onPress={() => void attachCandidate(candidate)}
                                            style={({ pressed }) => [
                                                styles.candidateButton,
                                                styles.candidateButtonPrimary,
                                                pressed && styles.candidateButtonPressed,
                                            ]}
                                        >
                                            {busy ? (
                                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                                            ) : (
                                                <Text style={[styles.candidateButtonText, styles.candidateButtonTextPrimary]}>
                                                    {t('inbox.attachCandidate')}
                                                </Text>
                                            )}
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })}
                    </ItemGroup>
                )}
                
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
