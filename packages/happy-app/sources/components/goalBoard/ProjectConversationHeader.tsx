import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalTaskSession } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storage } from '@/sync/storage';
import { isProjectSessionDeleted } from '@/sync/projectSessionLinks';
import { isProjectConversationArchived } from '@/sync/projectConversationLifecycle';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectConversationActions } from './ProjectConversationActions';

/** Scope and task conversations share explicit new/history actions without a permanent task column. */
export function ProjectConversationHeader({ sessions, selectedId, onSelect, onNew, onRefresh, loading, error, onRetry, onMore, onResolveNext, busy, offline, mobile = false, mobileMenu, testIDPrefix, scope = 'task', onGlobal, onClose, manage = false }: {
    sessions: GoalTaskSession[]; selectedId?: string; onSelect: (id: string) => void; onNew?: () => void;
    onResolveNext?: () => Promise<string | undefined>; onRefresh?: () => void; loading?: boolean; error?: string | null; onRetry?: () => void; onMore?: () => void;
    busy?: boolean; offline?: boolean; mobile?: boolean; testIDPrefix: string;
    mobileMenu?: { open: boolean; onClose: () => void; onView: (view: 'chat' | 'details' | 'files') => void; onInfo: () => void; onOrdinary: () => void; onProjectMenu: () => void; bottomInset?: number };
    scope?: 'task' | 'global'; onGlobal?: () => void; onClose?: () => void; manage?: boolean;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const anchor = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [mobilePanel, setMobilePanel] = React.useState<'main' | 'history' | 'manage'>('main');
    React.useEffect(() => { if (!mobileMenu?.open) setMobilePanel('main'); }, [mobileMenu?.open]);
    const [position, setPosition] = React.useState({ x: 12, y: 60 });
    const [headerWidth, setHeaderWidth] = React.useState(0);
    const compact = headerWidth < 560;
    const storedSessions = storage(state => state.sessions);
    const visibleSessions = sessions.filter(session => !isProjectSessionDeleted(session.sessionId)
        && !isProjectConversationArchived(session, storedSessions[session.sessionId]));
    const current = React.useRef({ selectedId, sessions, onSelect, onClose, onResolveNext });
    const handledRemoval = React.useRef<string | undefined>(undefined);
    if (current.current.selectedId !== selectedId) handledRemoval.current = undefined;
    current.current = { selectedId, sessions, onSelect, onClose, onResolveNext };
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // Completion may arrive after the store removed the current header. Keep
    // selection tied to the route, and choose from the latest remaining history.
    const advance = React.useCallback((removedId: string) => {
        if (!mounted.current || current.current.selectedId !== removedId || handledRemoval.current === removedId) return;
        handledRemoval.current = removedId;
        const headers = storage.getState().sessions;
        const next = current.current.sessions.find(session => session.sessionId !== removedId && !isProjectSessionDeleted(session.sessionId)
            && !isProjectConversationArchived(session, headers[session.sessionId]));
        if (next) { current.current.onSelect(next.sessionId); return; }
        const resolveNext = current.current.onResolveNext;
        if (!resolveNext) { current.current.onClose?.(); return; }
        void (async () => {
            try {
                const id = await resolveNext();
                if (!mounted.current || current.current.selectedId !== removedId) return;
                const candidate = current.current.sessions.find(session => session.sessionId === id) ?? { updatedAt: 0 };
                if (id && !isProjectSessionDeleted(id) && !isProjectConversationArchived(candidate, storage.getState().sessions[id])) current.current.onSelect(id);
                else current.current.onClose?.();
            } catch {
                if (mounted.current && current.current.selectedId === removedId) handledRemoval.current = undefined;
            }
        })();
    }, []);
    React.useEffect(() => {
        if (selectedId && (isProjectSessionDeleted(selectedId) || isProjectConversationArchived(sessions.find(session => session.sessionId === selectedId) ?? { updatedAt: 0 }, storedSessions[selectedId]))) void advance(selectedId);
    }, [selectedId, storedSessions, sessions, advance]);
    const historyLabel = t(scope === 'global' ? 'projectGoals.globalHistory' : 'projectGoals.history');
    const close = React.useCallback(() => { setOpen(false); mobileMenu?.onClose(); queueMicrotask(() => anchor.current?.focus()); }, [mobileMenu?.onClose]);
    const create = () => { close(); onNew?.(); };
    const menuWidth = Math.min(350, width - 24);
    const historyList = <ScrollView style={styles.list}>
                    {mobile && onNew && <Button variant="toolbar" label={t('projectGoals.newChat')} disabled={busy || offline} testID={`${testIDPrefix}-new-chat`} onPress={create}><Ionicons name="add-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.newChat')}</Text></Button>}
                    {visibleSessions.map(session => <Button key={session.sessionId} variant="row" label={session.title} selected={selectedId === session.sessionId} disabled={busy} testID={`${testIDPrefix}-history-${session.sessionId}`} onPress={() => { close(); onSelect(session.sessionId); }}><View style={styles.copy}><Text numberOfLines={2} style={styles.body}>{session.title}</Text><Text style={styles.meta}>{new Date(session.updatedAt).toLocaleString()}</Text></View></Button>)}
                    {loading && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                    {error && <><Text accessibilityRole="alert" style={styles.error}>{error}</Text>{onRetry && <Button label={t('common.retry')} onPress={onRetry}><Text style={styles.link}>{t('common.retry')}</Text></Button>}</>}
                    {onMore && <Button label={t('projectGoals.moreHistory')} disabled={loading} onPress={onMore}><Text style={styles.link}>{t('projectGoals.moreHistory')}</Text></Button>}
                    {!visibleSessions.length && !loading && <Text style={styles.meta}>{t(onNew ? 'projectGoals.noHistory' : 'projectGoals.noMatchingHistory')}</Text>}
                </ScrollView>;
    const action = (key: string, label: string, icon: React.ComponentProps<typeof Ionicons>['name'], onPress: () => void) =>
        <Button key={key} variant="row" touchTarget label={label} disabled={busy} testID={`${testIDPrefix}-mobile-${key}`} onPress={onPress}><Ionicons name={icon} size={20} color={theme.colors.textSecondary} /><Text style={styles.body}>{label}</Text></Button>;
    const renderMobileMenu = (actions: React.ReactNode) => mobileMenu?.open ? <Modal transparent visible animationType="none" onRequestClose={mobileMenu.onClose}>
        <HistoryEscape onClose={mobileMenu.onClose} />
        <Pressable style={[styles.backdrop, { backgroundColor: theme.colors.modal.backdrop }]} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={mobileMenu.onClose} />
        <View testID={`${testIDPrefix}-mobile-menu`} style={[styles.menu, { left: 12, right: 12, bottom: Math.max(12, mobileMenu.bottomInset ?? 0), maxHeight: height * 0.8 }]}>
            <View style={styles.mobileMenuHeader}>
                {mobilePanel !== 'main' && <Button variant="icon" label={t('common.back')} onPress={() => setMobilePanel('main')}><Ionicons name="chevron-back" size={20} color={theme.colors.text} /></Button>}
                <Text style={[styles.body, { flex: 1 }]}>{mobilePanel === 'history' ? historyLabel : mobilePanel === 'manage' ? t('sessionInfo.agentPanelSessionManagement') : t('sessionSearch.actions.more')}</Text>
                <Button variant="icon" label={t('common.cancel')} onPress={mobileMenu.onClose}><Ionicons name="close" size={20} color={theme.colors.text} /></Button>
            </View>
            {mobilePanel === 'history' ? historyList : <ScrollView style={styles.list}>
                {mobilePanel === 'main' ? <>
                    {(['chat', 'details', 'files'] as const).map(view => action(view, t(view === 'chat' ? 'projectGoals.mobileChat' : view === 'details' ? 'projectGoals.details' : 'projectGoals.files'), view === 'chat' ? 'chatbubble-outline' : view === 'details' ? 'reader-outline' : 'folder-outline', () => { mobileMenu.onClose(); mobileMenu.onView(view); }))}
                    {action('history', `${t('projectGoals.taskHistoryCompact')} · ${visibleSessions.length}`, 'time-outline', () => { setMobilePanel('history'); onRefresh?.(); })}
                    {selectedId && action('info', t('sessionInfo.viewDetails'), 'information-circle-outline', () => { mobileMenu.onClose(); mobileMenu.onInfo(); })}
                    {action('manage', t('sessionInfo.agentPanelSessionManagement'), 'options-outline', () => setMobilePanel('manage'))}
                    {action('project', t('projectGoals.allProjects'), 'grid-outline', () => { mobileMenu.onClose(); mobileMenu.onProjectMenu(); })}
                </> : <>
                    {selectedId && action('ordinary', t('projectGoals.openOrdinaryChat'), 'open-outline', () => { mobileMenu.onClose(); mobileMenu.onOrdinary(); })}
                    {actions}
                    {onClose && action('close', t('projectGoals.closeConversation'), 'close-outline', () => { mobileMenu.onClose(); onClose(); })}
                </>}
            </ScrollView>}
        </View>
    </Modal> : null;
    if (mobileMenu) return manage && selectedId && onClose
        ? <ProjectConversationActions key={selectedId} id={selectedId} testIDPrefix={testIDPrefix} disabled={busy} showLabels onBeforeAction={mobileMenu.onClose} onRemoved={() => advance(selectedId)} render={renderMobileMenu} />
        : renderMobileMenu(null);
    return <View style={styles.header} onLayout={event => setHeaderWidth(event.nativeEvent.layout.width)} testID={`${testIDPrefix}-conversation-header`}>
        {onGlobal && <Button variant="toolbar" label={t('projectGoals.globalConversation')} disabled={busy} testID={`${testIDPrefix}-global-chat`} onPress={onGlobal}><Ionicons name="compass-outline" size={16} color={theme.colors.textLink} />{!mobile && <Text style={styles.link}>{t(headerWidth < 440 ? 'projectGoals.globalConversationCompact' : 'projectGoals.globalConversation')}</Text>}</Button>}
        <Button ref={anchor} variant="toolbar" label={historyLabel} expanded={open} disabled={busy} testID={`${testIDPrefix}-history`} onPress={() => {
            anchor.current?.measureInWindow((x, y, _w, h) => { setPosition({ x, y: y + h + 6 }); setOpen(true); onRefresh?.(); });
        }}><Ionicons name="time-outline" size={16} color={theme.colors.textSecondary} /><Text numberOfLines={1} style={styles.meta}>{compact ? t(scope === 'global' ? 'projectGoals.globalHistoryCompact' : 'projectGoals.taskHistoryCompact') : historyLabel} · {visibleSessions.length}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button>
        <View style={{ flex: 1 }} />
        {!mobile && onNew && <Button variant="toolbar" label={t('projectGoals.newChat')} disabled={busy || offline} testID={`${testIDPrefix}-new-chat`} onPress={create}><Ionicons name="add-outline" size={16} color={theme.colors.textLink} />{!compact && <Text style={styles.link}>{t('projectGoals.newChat')}</Text>}</Button>}
        {manage && selectedId && onClose && <ProjectConversationActions key={selectedId} id={selectedId} testIDPrefix={testIDPrefix} disabled={busy} onRemoved={() => advance(selectedId)} />}
        {onClose && <Button variant="toolbar" label={t('projectGoals.closeConversation')} testID={`${testIDPrefix}-close-chat`} onPress={onClose}><Ionicons name="close-outline" size={18} color={theme.colors.textSecondary} /></Button>}
        {open && <Modal transparent visible animationType="none" onRequestClose={close}>
            <HistoryEscape onClose={close} />
            <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={close} />
            <View testID={`${testIDPrefix}-history-menu`} style={[styles.menu, { width: menuWidth, maxHeight: mobile ? height * 0.7 : Math.max(100, Math.min(360, height - position.y - 16)), left: Math.max(12, Math.min(position.x, width - menuWidth - 12)), ...(mobile ? { bottom: 12 } : { top: Math.max(12, Math.min(position.y, height - 180)) }) }]}>
                {historyList}
            </View>
        </Modal>}
    </View>;
}
function HistoryEscape({ onClose }: { onClose: () => void }) { useProjectModalEscape(onClose); return null; }

const styles = StyleSheet.create(theme => ({
    mobileMenuHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    backdrop: { position: 'absolute', inset: 0 },
    menu: { position: 'absolute', borderRadius: 12, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, overflow: 'hidden', shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    list: { flexGrow: 0, padding: 8 }, copy: { flex: 1, minWidth: 0, gap: 8 },
    body: { fontSize: 13, lineHeight: 21, color: theme.colors.text, ...Typography.default() },
    meta: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    link: { fontSize: 12, lineHeight: 18, color: theme.colors.textLink, ...Typography.default('semiBold') },
    error: { fontSize: 12, lineHeight: 19, color: theme.colors.textDestructive },
}));
