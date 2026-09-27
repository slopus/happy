import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from './StyledText';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useSessionListSyncState } from '@/sync/sessionListSyncState';

const styles = StyleSheet.create(theme => ({
    container: { padding: 12, gap: 8, alignItems: 'center' },
    message: { color: theme.colors.textSecondary, fontSize: 13 },
    button: { backgroundColor: theme.colors.surface, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    label: { color: theme.colors.text, fontSize: 13 },
}));

export function SessionListRecovery() {
    const { bootstrap, history } = useSessionListSyncState();
    if (bootstrap !== 'error' && history !== 'error') return null;
    const retryBootstrap = bootstrap === 'error';
    return <View style={styles.container} accessibilityLiveRegion="polite">
        <Text style={styles.message}>{t(retryBootstrap ? 'sessionHistory.failedToRefreshSessions' : 'sessionHistory.failedToLoadMore')}</Text>
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            onPress={() => { void (retryBootstrap ? sync.bootstrapSessions() : sync.loadNextSessionHistoryPage()); }}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
            <Text style={styles.label}>{t('common.retry')}</Text>
        </Pressable>
    </View>;
}
