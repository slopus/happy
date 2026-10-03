import * as React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAppConversationHistory } from '@/hooks/useAppConversationHistory';
import { useAllMachines } from '@/sync/storage';
import { Typography } from '@/constants/Typography';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { layout } from '@/components/layout';
import { t } from '@/text';

export const AppConversationHistoryView = React.memo(({ conversationId }: { conversationId?: string }) => {
    const { content, error, loading, refreshing, refresh } = useAppConversationHistory(conversationId);
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const machine = machines.find(item => item.id === content?.machineId);
    const appName = t('relationshipAdvisor.title');
    const state = content?.state;
    const scroll = React.useRef<ScrollView>(null);
    React.useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [conversationId]);
    const status = state === 'queued' ? t('appConversations.queued') : state === 'running' ? t('appConversations.running')
        : state === 'failed' ? t('appConversations.failed') : state === 'cancelled' ? t('appConversations.cancelled') : null;
    const errorText = error === 'key' ? t('appConversations.keyUnavailable') : error === 'removed'
        ? t('appConversations.historyRemoved') : t('appConversations.openFailed');
    return <View style={styles.root} testID="app-conversation-history">
        {conversationId ? <View style={styles.toolbar}>
            <View style={styles.details}>
                <Text style={styles.title}>{appName}</Text>
                <Text style={styles.secondary}>{content ? `${new Date(content.createdAt).toLocaleString()} · ${machine?.metadata?.displayName || machine?.metadata?.host || t('appConversations.deviceUnavailable')}` : t('appConversations.conversation')}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t('appConversations.refresh')} onPress={refresh} disabled={refreshing} accessibilityState={{ busy: refreshing }}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="app-conversation-history-refresh">
                {refreshing ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name="refresh-outline" size={19} color={theme.colors.textSecondary} />}
            </Pressable>
        </View> : null}
        <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={styles.content} testID="app-conversation-history-scroll">
            {!conversationId ? <View style={styles.notice}><Ionicons name="chatbubbles-outline" size={32} color={theme.colors.textSecondary} /><Text style={styles.noticeText}>{t('appConversations.selectConversation')}</Text></View>
                : loading ? <View style={styles.notice}><ActivityIndicator color={theme.colors.textSecondary} /><Text style={styles.noticeText}>{t('appConversations.opening')}</Text></View>
                : error ? <View style={styles.notice} testID="app-conversation-history-error"><Text style={styles.noticeText}>{errorText}</Text><Pressable accessibilityRole="button" onPress={refresh} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}><Text style={styles.title}>{t('common.retry')}</Text></Pressable></View>
                : content ? <View style={styles.thread} testID="app-conversation-history-messages">
                    {!content.messages.length ? <View style={styles.notice}><Text style={styles.noticeText}>{t('appConversations.noMessages')}</Text></View> : content.messages.map((message, index) => <View key={index} style={[styles.message, message.role === 'user' ? styles.userMessage : styles.assistantMessage]} testID={`app-history-message-${index}`}>
                        <View style={[styles.bubble, message.role === 'user' && styles.userBubble]}>
                            {message.images?.map((uri, imageIndex) => <Image key={imageIndex} source={{ uri }} resizeMode="contain" style={styles.image} accessibilityLabel={t('rightPanelCapabilityHub.meta.image')} />)}
                            {message.role === 'assistant' ? <MarkdownView markdown={message.text} readOnly /> : <Text selectable style={styles.userText}>{message.text}</Text>}
                        </View>
                    </View>)}
                    {status ? <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text> : null}
                </View> : null}
        </ScrollView>
        {conversationId ? <View style={styles.footer}><Ionicons name="lock-closed-outline" size={13} color={theme.colors.textSecondary} /><Text style={styles.secondary}>{t('appConversations.readOnly')}</Text></View> : null}
    </View>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    toolbar: { paddingHorizontal: 20, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    details: { flex: 1, gap: 4, minWidth: 0 },
    title: { color: theme.colors.text, fontSize: 15, ...Typography.default('semiBold') },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, ...Typography.default() },
    button: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    scroll: { flex: 1, minHeight: 0 },
    content: { flexGrow: 1, alignItems: 'center', padding: 20 },
    thread: { width: '100%', maxWidth: layout.maxWidth, gap: 16 },
    message: { width: '100%', flexDirection: 'row' },
    userMessage: { justifyContent: 'flex-end' },
    assistantMessage: { justifyContent: 'flex-start' },
    bubble: { maxWidth: '90%', minWidth: 0, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
    userBubble: { backgroundColor: theme.colors.surfaceSelected },
    userText: { fontSize: 16, lineHeight: 24, color: theme.colors.text, ...Typography.default() },
    image: { width: 260, maxWidth: '100%', height: 190, marginBottom: 8, borderRadius: 8 },
    notice: { flex: 1, width: '100%', maxWidth: layout.maxWidth, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
    noticeText: { color: theme.colors.textSecondary, fontSize: 15, lineHeight: 23, textAlign: 'center', ...Typography.default() },
    retry: { paddingHorizontal: 20, minHeight: 44, justifyContent: 'center', borderRadius: 8, backgroundColor: theme.colors.surface },
    status: { alignSelf: 'center', color: theme.colors.textSecondary, fontSize: 13, padding: 12, ...Typography.default() },
    footer: { padding: 12, flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
}));
