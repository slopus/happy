import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSessionListViewData } from '@/sync/storage';
import { isApplicationSession } from '@slopus/happy-wire';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePathname, useRouter } from 'expo-router';

/** Native application sessions use the same synchronized history as ordinary sessions. */
export function AppConversationsSidebar({ visible = true, showTitle = true, onNavigate }: { visible?: boolean; showTitle?: boolean; onNavigate?: (path: string) => void }) {
    const router = useRouter();
    const pathname = usePathname();
    const { theme } = useUnistyles();
    const [expandedHistory, setExpandedHistory] = React.useState<Record<string, boolean>>({});
    const sessionList = useSessionListViewData();
    const nativeSessions = React.useMemo(() => (sessionList ?? []).flatMap(item =>
        item.type === 'active-sessions' ? item.sessions : item.type === 'session' ? [item.session] : []
    ).filter(row => isApplicationSession(row)).sort((a, b) => (b.activityAt ?? b.updatedAt ?? 0) - (a.activityAt ?? a.updatedAt ?? 0)), [sessionList]);

    const groups = [...new Set(nativeSessions.map(session => session.application!.appId))];
    const manage = () => { if (onNavigate) onNavigate('/settings/authorized-apps'); else router.push('/settings/authorized-apps' as never); };
    return <View style={styles.container} testID="app-conversations-sidebar">
        <View style={[styles.header, !showTitle && styles.compactHeader]}>
            {showTitle ? <Text style={styles.heading}>{t('appConversations.title')}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityLabel={t('appAuthorization.listTitle')} onPress={manage} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <Ionicons name="shield-checkmark-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
            {!groups.length ? <View style={styles.notice}><Text style={styles.title}>{t('appConversations.empty')}</Text><Text style={styles.secondary}>{t('connectedApps.emptyHint')}</Text></View> : null}
            {groups.map(appId => {
                const appSessions = nativeSessions.filter(session => session.application?.appId === appId);
                // Use the same archive policy as history, row actions and storage,
                // including an explicit restore of the current completed turn.
                const inHistory = (session: typeof appSessions[number]) => session.archived;
                const currentSessions = appSessions.filter(session => !inHistory(session));
                const historySessions = appSessions.filter(inHistory);
                return <View key={appId} testID={`app-conversations-group-${appId}`}>
                    <View style={styles.groupHeader}><Text style={styles.groupTitle}>{appId === 'relationship-advisor' ? t('relationshipAdvisor.title') : appId}</Text></View>
                    {currentSessions.map(session => <CompactSessionRow key={session.id} session={session}
                        selected={pathname === `/session/${encodeURIComponent(session.id)}` || pathname.startsWith(`/session/${encodeURIComponent(session.id)}/`)}
                        showLocation testID={`app-native-session-${session.id}`} />)}
                    {historySessions.length > 0 ? <View>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('sessionHistory.title')}
                            accessibilityState={{ expanded: !!expandedHistory[appId] }} testID={`app-history-toggle-${appId}`}
                            onPress={() => setExpandedHistory(value => ({ ...value, [appId]: !value[appId] }))}
                            style={({ pressed }) => [styles.groupHeader, pressed && styles.pressed]}>
                            <Text style={styles.secondary}>{t('sessionHistory.title')} · {historySessions.length}</Text>
                            <Ionicons name={expandedHistory[appId] ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                        {expandedHistory[appId] ? historySessions.map(session => <CompactSessionRow key={session.id} session={session}
                            selected={pathname === `/session/${encodeURIComponent(session.id)}` || pathname.startsWith(`/session/${encodeURIComponent(session.id)}/`)}
                            showLocation testID={`app-native-session-${session.id}`} />) : null}
                    </View> : null}

                </View>;
            })}
        </ScrollView>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    container: { flex: 1, minHeight: 0 },
    content: { padding: 12, gap: 16 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, minHeight: 48 },
    compactHeader: { minHeight: 36, justifyContent: 'flex-end' },
    heading: { flex: 1, color: theme.colors.text, fontSize: 16, ...Typography.default('semiBold') },
    title: { color: theme.colors.text, fontSize: 14, ...Typography.default() },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, ...Typography.default() },
    iconButton: { minWidth: 36, minHeight: 36, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    groupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 8 },
    groupTitle: { color: theme.colors.textSecondary, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    row: { padding: 10, gap: 4, borderRadius: 10, marginBottom: 4, backgroundColor: theme.colors.surface },
    statusRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    notice: { padding: 16, gap: 8 },
    emptyGroup: { padding: 12, color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    action: { minHeight: 40, padding: 10, justifyContent: 'center', borderRadius: 8 },
}));
