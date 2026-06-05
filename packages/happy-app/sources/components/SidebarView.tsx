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

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
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
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();

    const handleNewSession = React.useCallback(() => {
        router.navigate('/new');
    }, [router]);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top + headerHeight }]}>
            {/* New Session button */}
            <Pressable
                onPress={handleNewSession}
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

            {/* Settings at bottom */}
            <Pressable
                onPress={() => router.push('/settings')}
                style={styles.settingsRow}
            >
                <Ionicons name="settings-outline" size={18} color={stylesheet.settingsText.color} />
                <Text style={styles.settingsText}>{t('settings.title')}</Text>
            </Pressable>
        </View>
    );
});
