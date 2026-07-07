import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useNavigation } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus, useFriendRequests, useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl } from '@/sync/profile';
import { MainView } from './MainView';
import { Avatar } from './Avatar';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useDrawerHaptics } from './useDrawerHaptics';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    messagesRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 2,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        gap: 10,
    },
    messagesText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    badge: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 11,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        gap: 8,
    },
    newSessionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    newSessionText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    userCard: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 6,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        gap: 12,
    },
    userCardPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    userName: {
        flex: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

export const SidebarView = React.memo(() => {
    useDrawerHaptics();
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const navigation = useNavigation();
    const realtimeStatus = useRealtimeStatus();
    const friendRequests = useFriendRequests();
    const profile = useProfile();
    const displayName = getDisplayName(profile) ?? t('settings.title');

    // Navigate, closing the drawer first. On phone the drawer is a `front` overlay
    // that would otherwise stay open on top of the pushed screen; on desktop the
    // drawer is permanent so closeDrawer is a harmless no-op.
    const go = React.useCallback((path: string) => {
        navigation.dispatch(DrawerActions.closeDrawer());
        router.navigate(path as any);
    }, [navigation, router]);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top + 12 }]}>
            {/* User card — tap to open settings (replaces the old gear row) */}
            <Pressable
                onPress={() => go('/settings')}
                style={({ pressed }) => [
                    styles.userCard,
                    pressed && styles.userCardPressed,
                ]}
            >
                <Avatar
                    id={profile.id}
                    size={40}
                    imageUrl={getAvatarUrl(profile)}
                    thumbhash={profile.avatar?.thumbhash}
                />
                <Text style={styles.userName} numberOfLines={1}>{displayName}</Text>
                <Ionicons name="settings-outline" size={18} color={stylesheet.userName.color} />
            </Pressable>

            {/* Messages / friends (formerly the Inbox tab) */}
            <Pressable onPress={() => go('/inbox')} style={styles.messagesRow}>
                <Ionicons name="chatbubble-ellipses-outline" size={17} color={stylesheet.messagesText.color} />
                <Text style={styles.messagesText}>{t('tabs.inbox')}</Text>
                {friendRequests.length > 0 && (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{friendRequests.length}</Text>
                    </View>
                )}
            </Pressable>

            {/* New Session button */}
            <Pressable
                onPress={() => go('/new')}
                style={({ pressed }) => [
                    styles.newSessionButton,
                    pressed && styles.newSessionButtonPressed,
                ]}
            >
                <Ionicons name="create-outline" size={16} color={stylesheet.newSessionText.color} />
                <Text style={styles.newSessionText}>{t('sidebar.newSession')}</Text>
            </Pressable>

            {realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="sidebar" />
            )}

            {/* Sessions list */}
            <MainView variant="sidebar" />
        </View>
    );
});
