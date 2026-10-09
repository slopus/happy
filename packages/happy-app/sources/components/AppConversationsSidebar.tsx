import * as React from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { useAllMachines, useSessionListViewData } from '@/sync/storage';
import { isApplicationSession } from '@slopus/happy-wire';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { getServerUrl } from '@/sync/serverConfig';
import { appAuthorizationRequest, isAppGrantActive, type AppAuthorizationGrant, type AppConversationDirectory } from '@/sync/apiAppDelegation';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { usePathname, useRouter } from 'expo-router';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { AppConnectionsMenu } from './AppConnectionsMenu';

const emptyDirectory: AppConversationDirectory = { conversations: [], nextCursor: null };
const appInfo = (id: string) => id === 'relationship-advisor'
    ? { name: t('relationshipAdvisor.title'), origin: 'https://advisor.paws.rodeo' }
    : { name: id, origin: null };
const turnLabel = (state?: string) => {
    switch (state) {
        case 'queued': return t('appConversations.queued');
        case 'running': return t('appConversations.running');
        case 'completed': return t('appConversations.completed');
        case 'failed': return t('appConversations.failed');
        case 'cancelled': return t('appConversations.cancelled');
        default: return t('appConversations.idle');
    }
};
const grantLabel = (grant: AppAuthorizationGrant) => grant.state === 'revoked'
    ? t('appConversations.revoked')
    : !isAppGrantActive(grant) ? t('appConversations.expired')
        : grant.expiresAt === null ? t('appConversations.permanent') : new Date(grant.expiresAt).toLocaleString();

/** An owner directory only: opening this panel never starts or resumes an execution. */
export function AppConversationsSidebar({ visible = true, showTitle = true, onNavigate }: { visible?: boolean; showTitle?: boolean; onNavigate?: (path: string) => void }) {
    const { credentials } = useAuth();
    const token = credentials?.token;
    const server = getServerUrl();
    const router = useRouter();
    const pathname = usePathname();
    const openConversation = (id: string) => {
        const path = `/apps/conversations/${encodeURIComponent(id)}`;
        if (onNavigate) onNavigate(path); else router.navigate(path as any);
    };
    const sessionList = useSessionListViewData();
    const nativeSessions = React.useMemo(() => (sessionList ?? []).flatMap(item =>
        item.type === 'active-sessions' ? item.sessions : item.type === 'session' ? [item.session] : []
    ).filter(row => isApplicationSession(row)).sort((a, b) => (b.activityAt ?? b.updatedAt ?? 0) - (a.activityAt ?? a.updatedAt ?? 0)), [sessionList]);
    const machines = useAllMachines({ includeOffline: true });
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const [expandedHistory, setExpandedHistory] = React.useState<Record<string, boolean>>({});
    const [cursor, setCursor] = React.useState<string | null>(null);
    const [revision, setRevision] = React.useState(0);
    const [snapshot, setSnapshot] = React.useState<{ token: string; server: string; grants: AppAuthorizationGrant[]; directory: AppConversationDirectory } | null>(null);
    const [error, setError] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [menu, setMenu] = React.useState<{ appId: string; x: number; y: number } | null>(null);
    const trigger = React.useRef<any>(null);
    const menuTriggers = React.useRef(new Map<string, any>());
    const owner = React.useRef({ token, server });
    owner.current = { token, server };
    const data = snapshot?.token === token && snapshot?.server === server ? snapshot : null;
    const grants = data?.grants ?? [];
    const directory = data?.directory ?? emptyDirectory;
    const groups = [...new Set([...grants.map(grant => grant.appId), ...nativeSessions.map(session => session.application!.appId)])];
    const selectedGrants = grants.filter(grant => grant.appId === menu?.appId);
    const deviceName = (id: string | null) => {
        const machine = machines.find(value => value.id === id);
        return machine?.metadata?.displayName || machine?.metadata?.host || t('appConversations.deviceUnavailable');
    };
    const refresh = () => { setCursor(null); setRevision(value => value + 1); };
    const openMenu = (appId: string) => {
        const node = menuTriggers.current.get(appId);
        trigger.current = node;
        if (node?.measureInWindow) node.measureInWindow((x: number, y: number, w: number, h: number) => setMenu({ appId, x: x + w, y: y + h }));
        else {
            const rect = node?.getBoundingClientRect?.();
            setMenu({ appId, x: rect?.right ?? width / 2, y: rect?.bottom ?? 60 });
        }
    };
    const closeMenu = () => { setMenu(null); setTimeout(() => trigger.current?.focus?.(), 0); };

    React.useEffect(() => { setCursor(null); setSnapshot(null); setMenu(null); setError(false); setExpandedHistory({}); }, [token, server]);
    React.useEffect(() => {
        if (!token || !visible) return;
        let disposed = false;
        let running = false;
        const controller = new AbortController();
        const load = async () => {
            if (running || (AppState.currentState && AppState.currentState !== 'active') || (Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden)) return;
            running = true;
            setLoading(true);
            try {
                const [authorization, conversations] = await Promise.all([
                    appAuthorizationRequest<{ grants: AppAuthorizationGrant[] }>(token, '', undefined, 'GET', controller.signal),
                    appAuthorizationRequest<AppConversationDirectory>(token, `/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, 'GET', controller.signal),
                ]);
                if (!disposed) { setSnapshot({ token, server, grants: authorization.grants, directory: conversations }); setError(false); }
            } catch {
                if (!disposed) setError(true);
            } finally {
                running = false;
                if (!disposed) setLoading(false);
            }
        };
        void load();
        // Native session state already arrives through sync. Fetch the legacy
        // directory on entry/foreground or explicit actions, never on a timer.
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
        const documentTarget = Platform.OS === 'web' && typeof document !== 'undefined' ? document : undefined;
        const onVisibilityChange = () => { if (!documentTarget?.hidden) void load(); };
        documentTarget?.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            disposed = true;
            controller.abort();
            subscription.remove();
            documentTarget?.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [token, server, cursor, revision, visible]);

    const changeGrant = async (grant: AppAuthorizationGrant, remove: boolean) => {
        if (!token || busy) return;
        if (!await Modal.confirm(remove ? t('appConversations.remove') : t('appConversations.revoke'), remove ? t('appConversations.removeConfirm') : t('appConversations.revokeConfirm'), { confirmText: remove ? t('appConversations.remove') : t('appConversations.revoke'), destructive: true })) return;
        if (owner.current.token !== token || owner.current.server !== server) return;
        setBusy(true);
        try {
            await appAuthorizationRequest(token, `/${grant.id}${remove ? '/history' : ''}`, undefined, 'DELETE');
            closeMenu(); refresh();
        } catch { setError(true); }
        finally { setBusy(false); }
    };

    return <View style={styles.container} testID="app-conversations-sidebar">
        <View style={[styles.header, !showTitle && styles.compactHeader]}>
            {showTitle ? <Text style={styles.heading}>{t('appConversations.title')}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityLabel={t('appConversations.refresh')} onPress={refresh} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                {loading ? <ActivityIndicator size="small" /> : <Ionicons name="refresh-outline" size={18} color={theme.colors.textSecondary} />}
            </Pressable>
        </View>
        {error ? <Pressable onPress={refresh} accessibilityRole="button" style={styles.notice}><Text style={styles.secondary}>{t('appConversations.loadFailed')} · {t('appConversations.refresh')}</Text></Pressable> : null}
        <ScrollView contentContainerStyle={styles.content}>
            {!loading && !error && !groups.length ? <View style={styles.notice}><Text style={styles.title}>{t('appConversations.empty')}</Text><Text style={styles.secondary}>{t('appConversations.emptyHint')}</Text></View> : null}
            {groups.map(appId => {
                const app = appInfo(appId);
                const appSessions = nativeSessions.filter(session => session.application?.appId === appId);
                // Use the same archive policy as history, row actions and storage,
                // including an explicit restore of the current completed turn.
                const inHistory = (session: typeof appSessions[number]) => session.archived;
                const currentSessions = appSessions.filter(session => !inHistory(session));
                const historySessions = appSessions.filter(inHistory);
                const ids = new Set(grants.filter(grant => grant.appId === appId).map(grant => grant.id));
                const conversations = directory.conversations.filter(conversation => ids.has(conversation.grantId));
                return <View key={appId} testID={`app-conversations-group-${appId}`}>
                    <View style={styles.groupHeader}>
                        <Text style={styles.groupTitle}>{app.name}</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel={`${app.name} · ${t('appConversations.groupMenu')}`} accessibilityState={{ expanded: menu?.appId === appId }}
                            ref={node => { if (node) menuTriggers.current.set(appId, node); else menuTriggers.current.delete(appId); }} onPress={() => openMenu(appId)}
                            testID={`app-conversations-menu-${appId}`} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
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
                    {!conversations.length && !appSessions.length ? <Text style={styles.emptyGroup}>{t('appConversations.noConversations')}</Text> : conversations.map(conversation => {
                        const grant = grants.find(value => value.id === conversation.grantId)!;
                        const state = conversation.turns[0]?.state;
                        return <Pressable key={conversation.id} accessibilityRole="button" accessibilityLabel={`${t('appConversations.openConversation')} · ${new Date(conversation.createdAt).toLocaleString()}`} accessibilityHint={t('appConversations.openHint')} aria-pressed={pathname === `/apps/conversations/${conversation.id}`} accessibilityState={{ selected: pathname === `/apps/conversations/${conversation.id}` }} onPress={() => openConversation(conversation.id)} style={({ pressed }) => [styles.row, pathname === `/apps/conversations/${conversation.id}` && styles.selected, pressed && styles.pressed]} testID={`app-conversation-${conversation.id}`}>
                            <Text style={styles.title} numberOfLines={1}>{t('appConversations.conversation')} · {new Date(conversation.createdAt).toLocaleString()}</Text>
                            <Text style={styles.secondary} numberOfLines={1}>{deviceName(grant.machineId)}</Text>
                            <View style={styles.statusRow}>
                                <Text style={styles.secondary}>{turnLabel(state)}</Text>
                                <Text style={styles.secondary}>{new Date(conversation.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                            </View>
                            {!isAppGrantActive(grant) ? <Text style={styles.secondary}>{grantLabel(grant)} · {t('appConversations.retained')}</Text> : null}
                        </Pressable>;
                    })}
                </View>;
            })}
            {cursor ? <Pressable onPress={refresh} accessibilityRole="button" style={styles.action}><Text style={styles.title}>{t('common.back')}</Text></Pressable> : null}
            {directory.nextCursor ? <Pressable onPress={() => setCursor(directory.nextCursor)} accessibilityRole="button" style={styles.action}><Text style={styles.title}>{t('appConversations.loadMore')}</Text></Pressable> : null}
        </ScrollView>
        {menu ? <AppConnectionsMenu app={appInfo(menu.appId)} anchor={menu} grants={selectedGrants}
            deviceName={deviceName} busy={busy} onClose={closeMenu}
            onOpenApp={() => { const url = appInfo(menu.appId).origin; closeMenu(); if (url) void openExternalUrl(url); }}
            onChangeGrant={(grant, remove) => void changeGrant(grant, remove)} /> : null}
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
