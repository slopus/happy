import * as React from 'react';
import { ActivityIndicator, AppState, Modal as NativeModal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { useAllMachines } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { appAuthorizationRequest, isAppGrantActive, type AppAuthorizationGrant, type AppConversationDirectory } from '@/sync/apiAppDelegation';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';

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
export function AppConversationsSidebar({ visible = true }: { visible?: boolean }) {
    const { credentials } = useAuth();
    const token = credentials?.token;
    const server = getServerUrl();
    const machines = useAllMachines({ includeOffline: true });
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const [cursor, setCursor] = React.useState<string | null>(null);
    const [revision, setRevision] = React.useState(0);
    const [snapshot, setSnapshot] = React.useState<{ token: string; server: string; grants: AppAuthorizationGrant[]; directory: AppConversationDirectory } | null>(null);
    const [error, setError] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [menu, setMenu] = React.useState<{ appId: string; x: number; y: number } | null>(null);
    const trigger = React.useRef<any>(null);
    const menuTriggers = React.useRef(new Map<string, any>());
    const firstAction = React.useRef<any>(null);
    const owner = React.useRef({ token, server });
    owner.current = { token, server };
    const data = snapshot?.token === token && snapshot?.server === server ? snapshot : null;
    const grants = data?.grants ?? [];
    const directory = data?.directory ?? emptyDirectory;
    const groups = [...new Set(grants.map(grant => grant.appId))];
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

    React.useEffect(() => { setCursor(null); setSnapshot(null); setMenu(null); setError(false); }, [token, server]);
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
        const timer = setInterval(() => void load(), 10_000);
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
        return () => { disposed = true; controller.abort(); clearInterval(timer); subscription.remove(); };
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
    const menuWidth = Math.min(340, width - 24);
    const menuHeight = Math.min(560, height - 48);

    return <View style={styles.container} testID="app-conversations-sidebar">
        <View style={styles.header}>
            <Text style={styles.heading}>{t('appConversations.title')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('appConversations.refresh')} onPress={refresh} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                {loading ? <ActivityIndicator size="small" /> : <Ionicons name="refresh-outline" size={18} color={theme.colors.textSecondary} />}
            </Pressable>
        </View>
        {error ? <Pressable onPress={refresh} accessibilityRole="button" style={styles.notice}><Text style={styles.secondary}>{t('appConversations.loadFailed')} · {t('appConversations.refresh')}</Text></Pressable> : null}
        <ScrollView contentContainerStyle={styles.content}>
            {!loading && !error && !groups.length ? <View style={styles.notice}><Text style={styles.title}>{t('appConversations.empty')}</Text><Text style={styles.secondary}>{t('appConversations.emptyHint')}</Text></View> : null}
            {groups.map(appId => {
                const app = appInfo(appId);
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
                    {!conversations.length ? <Text style={styles.emptyGroup}>{t('appConversations.noConversations')}</Text> : conversations.map(conversation => {
                        const grant = grants.find(value => value.id === conversation.grantId)!;
                        const state = conversation.turns[0]?.state;
                        return <View key={conversation.id} style={styles.row} testID={`app-conversation-${conversation.id}`}>
                            <Text style={styles.title} numberOfLines={1}>{t('appConversations.conversation')} · {new Date(conversation.createdAt).toLocaleString()}</Text>
                            <Text style={styles.secondary} numberOfLines={1}>{deviceName(grant.machineId)}</Text>
                            <View style={styles.statusRow}>
                                <Text style={styles.secondary}>{turnLabel(state)}</Text>
                                <Text style={styles.secondary}>{new Date(conversation.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                            </View>
                            {!isAppGrantActive(grant) ? <Text style={styles.secondary}>{grantLabel(grant)} · {t('appConversations.retained')}</Text> : null}
                        </View>;
                    })}
                </View>;
            })}
            {cursor ? <Pressable onPress={refresh} accessibilityRole="button" style={styles.action}><Text style={styles.title}>{t('common.back')}</Text></Pressable> : null}
            {directory.nextCursor ? <Pressable onPress={() => setCursor(directory.nextCursor)} accessibilityRole="button" style={styles.action}><Text style={styles.title}>{t('appConversations.loadMore')}</Text></Pressable> : null}
        </ScrollView>
        {menu ? <NativeModal transparent visible animationType="none" onRequestClose={closeMenu} onShow={() => firstAction.current?.focus?.()}>
            <View style={styles.modalRoot}>
                <Pressable style={styles.backdrop} onPress={closeMenu} accessibilityLabel={t('sidebarLists.close')} />
                <View style={[styles.menu, { width: menuWidth, maxHeight: menuHeight, left: Platform.OS === 'web' ? Math.max(12, Math.min(width - menuWidth - 12, menu.x - menuWidth)) : (width - menuWidth) / 2, top: Math.max(24, Math.min(height - menuHeight - 24, menu.y + 12)) }]} testID="app-conversations-group-menu">
                    <View style={styles.header}><Text style={styles.heading}>{appInfo(menu.appId).name}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('sidebarLists.close')} onPress={closeMenu} style={styles.iconButton}><Ionicons name="close" size={18} color={theme.colors.text} /></Pressable></View>
                    <ScrollView>
                        {appInfo(menu.appId).origin ? <Pressable ref={firstAction} accessibilityRole="button" onPress={() => { const url = appInfo(menu.appId).origin!; closeMenu(); void openExternalUrl(url); }} style={({ pressed }) => [styles.action, pressed && styles.pressed]}><Text style={styles.title}>{t('appConversations.openApp')} ↗</Text></Pressable> : null}
                        <Text style={styles.sectionTitle}>{t('appConversations.manage')}</Text>
                        {selectedGrants.map(grant => <View key={grant.id} style={styles.connection}>
                            <Text style={styles.title} numberOfLines={1}>{deviceName(grant.machineId)}</Text>
                            <Text style={styles.secondary}>{t('appConversations.connection')} · {new Date(grant.createdAt).toLocaleString()}</Text>
                            <Text style={styles.secondary}>{grantLabel(grant)}</Text>
                            {isAppGrantActive(grant) ? <Pressable disabled={busy} accessibilityRole="button" onPress={() => void changeGrant(grant, false)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}><Text style={styles.title}>{t('appConversations.revoke')}</Text></Pressable> : null}
                            <Pressable disabled={busy} accessibilityRole="button" onPress={() => void changeGrant(grant, true)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}><Text style={styles.title}>{t('appConversations.remove')}</Text></Pressable>
                        </View>)}
                    </ScrollView>
                </View>
            </View>
        </NativeModal> : null}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    container: { flex: 1, minHeight: 0 },
    content: { padding: 12, gap: 16 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, minHeight: 48 },
    heading: { flex: 1, color: theme.colors.text, fontSize: 16, ...Typography.default('semiBold') },
    title: { color: theme.colors.text, fontSize: 14, ...Typography.default() },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, ...Typography.default() },
    iconButton: { minWidth: 36, minHeight: 36, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    groupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 8 },
    groupTitle: { color: theme.colors.textSecondary, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    row: { padding: 10, gap: 4, borderRadius: 10, marginBottom: 4, backgroundColor: theme.colors.surface },
    statusRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    notice: { padding: 16, gap: 8 },
    emptyGroup: { padding: 12, color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    action: { minHeight: 40, padding: 10, justifyContent: 'center', borderRadius: 8 },
    modalRoot: { flex: 1 },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    menu: { position: 'absolute', backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 12, padding: 6, overflow: 'hidden' },
    connection: { padding: 10, gap: 6, borderTopColor: theme.colors.divider, borderTopWidth: StyleSheet.hairlineWidth },
    sectionTitle: { color: theme.colors.textSecondary, padding: 10, fontSize: 12, ...Typography.default('semiBold') },
}));
