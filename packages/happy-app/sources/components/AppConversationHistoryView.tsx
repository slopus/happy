import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAppConversationHistory } from '@/hooks/useAppConversationHistory';
import { useLocalSetting } from '@/sync/storage';
import { appConversationToMessages } from '@/sync/appConversationTranscript';
import { AgentContentView } from './AgentContentView';
import { ReadOnlyChatList } from './ChatList';
import { DesktopReadingWidthContext } from './DesktopReadingWidth';
import { layout } from './layout';
import { t } from '@/text';

export const AppConversationHistoryView = React.memo(({ conversationId }: { conversationId?: string }) => {
    const { content, error, loading, refreshing, refresh } = useAppConversationHistory(conversationId);
    const { theme } = useUnistyles();
    const desktopSkinId = useLocalSetting('desktopSkinId');
    const desktopReadingWidth = useLocalSetting('desktopReadingWidth');
    const [width, setWidth] = React.useState(0);
    const messages = React.useMemo(() => content ? appConversationToMessages(content) : [], [content]);
    const state = content?.state;
    const status = state === 'queued' ? t('appConversations.queued') : state === 'running' ? t('appConversations.running')
        : state === 'failed' ? t('appConversations.failed') : state === 'cancelled' ? t('appConversations.cancelled') : null;
    const errorText = error === 'key' ? t('appConversations.keyUnavailable') : error === 'removed'
        ? t('appConversations.historyRemoved') : t('appConversations.openFailed');
    const placeholder = !conversationId ? t('appConversations.selectConversation') : error ? errorText
        : !loading && !messages.length ? t('appConversations.noMessages') : null;
    return <View style={styles.root} testID="app-conversation-history" onLayout={event => setWidth(event.nativeEvent.layout.width)}>
        {conversationId ? <Stack.Screen options={{
            headerTitle: [t('relationshipAdvisor.title'), status].filter(Boolean).join(' · '),
            headerRight: () => <Pressable accessibilityRole="button" accessibilityLabel={t('appConversations.refresh')}
                onPress={refresh} disabled={refreshing} accessibilityState={{ busy: refreshing }}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="app-conversation-history-refresh">
                {refreshing ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name="refresh-outline" size={19} color={theme.colors.textSecondary} />}
            </Pressable>,
        }} /> : null}
        <DesktopReadingWidthContext.Provider value={Platform.OS === 'web' && desktopSkinId !== 'default' ? desktopReadingWidth : layout.maxWidth}>
            <AgentContentView
                content={content && messages.length ? <ReadOnlyChatList scopeId={`app:${conversationId}`} messages={messages}
                    desktopMainWidth={width} currentTurnActive={state === 'running' || state === 'queued'} /> : null}
                placeholder={loading ? <ActivityIndicator color={theme.colors.textSecondary} /> : placeholder ? <View style={styles.notice} testID={error ? 'app-conversation-history-error' : undefined}>
                    <Text style={styles.noticeText}>{placeholder}</Text>
                    {error ? <Pressable accessibilityRole="button" onPress={refresh} style={({ pressed }) => [styles.button, pressed && styles.pressed]}><Text style={styles.noticeText}>{t('common.retry')}</Text></Pressable> : null}
                </View> : null}
            />
        </DesktopReadingWidthContext.Provider>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    button: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    notice: { maxWidth: layout.maxWidth, alignItems: 'center', gap: 14, padding: 24 },
    noticeText: { color: theme.colors.textSecondary, fontSize: 15, lineHeight: 23, textAlign: 'center' },
}));
