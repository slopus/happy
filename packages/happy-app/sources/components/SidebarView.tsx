import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { MainView } from './MainView';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { ShortcutHintBadge, useShortcutHints } from './ShortcutHints';

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
    const { visible: shortcutHintsVisible } = useShortcutHints();

    const handleNewSession = React.useCallback(() => {
        router.navigate('/new');
    }, [router]);
    const handleOpenArchive = React.useCallback(() => {
        router.push('/archive');
    }, [router]);

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
                <Pressable
                    onPress={handleOpenArchive}
                    accessibilityLabel={t('sidebar.archive')}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                        styles.archiveButton,
                        pressed && styles.newSessionButtonPressed,
                    ]}
                >
                    <Ionicons
                        name="archive-outline"
                        size={18}
                        color={stylesheet.newSessionText.color}
                    />
                </Pressable>
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
