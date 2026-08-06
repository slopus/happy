import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus, useSettingMutable } from '@/sync/storage';
import { MainView } from './MainView';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { ShortcutHintBadge, useShortcutHints } from './ShortcutHints';
import { useHasArchivedSessions } from '@/hooks/useVisibleSessionListViewData';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    topControls: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        gap: 8,
    },
    newSessionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
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
    archiveButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    archiveButtonActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    shortcutTargetActive: {
        backgroundColor: theme.colors.surfacePressed,
    },
    newSessionText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        gap: 10,
    },
    settingsText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default(),
    },
    shortcutBadgeInline: {
        marginLeft: 'auto',
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const hasArchivedSessions = useHasArchivedSessions();
    // Stored under its original `hideInactiveSessions` key — synced settings
    // have no rename migration — but it hides archived sessions only.
    const [hideArchivedSessions, setHideArchivedSessions] = useSettingMutable('hideInactiveSessions');
    const { visible: shortcutHintsVisible } = useShortcutHints();

    const handleNewSession = React.useCallback(() => {
        router.navigate('/new');
    }, [router]);
    const handleArchiveVisibility = React.useCallback(() => {
        setHideArchivedSessions(!hideArchivedSessions);
    }, [hideArchivedSessions, setHideArchivedSessions]);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top + headerHeight }]}>
            <View style={styles.topControls}>
                <Pressable
                    onPress={handleNewSession}
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        shortcutHintsVisible && styles.shortcutTargetActive,
                        pressed && styles.newSessionButtonPressed,
                    ]}
                >
                    <Ionicons name="create-outline" size={16} color={stylesheet.newSessionText.color} />
                    <Text style={styles.newSessionText}>{t('sidebar.newSession')}</Text>
                    <ShortcutHintBadge shortcutKey="N" style={styles.shortcutBadgeInline} />
                </Pressable>
                {hasArchivedSessions && (
                    <Pressable
                        onPress={handleArchiveVisibility}
                        accessibilityLabel={hideArchivedSessions
                            ? t('sidebar.showArchived')
                            : t('sidebar.hideArchived')}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !hideArchivedSessions }}
                        style={({ pressed }) => [
                            styles.archiveButton,
                            !hideArchivedSessions && styles.archiveButtonActive,
                            pressed && styles.newSessionButtonPressed,
                        ]}
                    >
                        <Ionicons
                            name={hideArchivedSessions ? 'archive-outline' : 'archive'}
                            size={18}
                            color={stylesheet.newSessionText.color}
                        />
                    </Pressable>
                )}
            </View>

            {realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="sidebar" />
            )}

            {/* Sessions list */}
            <MainView variant="sidebar" />

            {/* Settings at bottom */}
            <Pressable
                onPress={() => router.push('/settings')}
                style={[
                    styles.settingsRow,
                    shortcutHintsVisible && styles.shortcutTargetActive,
                ]}
            >
                <Ionicons name="settings-outline" size={18} color={stylesheet.settingsText.color} />
                <Text style={styles.settingsText}>{t('settings.title')}</Text>
                <ShortcutHintBadge shortcutKey="," style={styles.shortcutBadgeInline} />
            </Pressable>
        </View>
    );
});
