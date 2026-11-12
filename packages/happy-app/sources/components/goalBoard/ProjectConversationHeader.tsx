import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalTaskSession } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { GoalBoardButton as Button } from './GoalBoardButton';

/** Scope and task conversations share explicit new/history actions without a permanent task column. */
export function ProjectConversationHeader({ sessions, selectedId, onSelect, onNew, onRefresh, loading, error, onRetry, onMore, busy, offline, mobile = false, testIDPrefix }: {
    sessions: GoalTaskSession[]; selectedId?: string; onSelect: (id: string) => void; onNew?: () => void;
    onRefresh?: () => void; loading?: boolean; error?: string | null; onRetry?: () => void; onMore?: () => void;
    busy?: boolean; offline?: boolean; mobile?: boolean; testIDPrefix: string;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const anchor = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [position, setPosition] = React.useState({ x: 12, y: 60 });
    const close = React.useCallback(() => { setOpen(false); queueMicrotask(() => anchor.current?.focus()); }, []);
    const create = () => { close(); onNew?.(); };
    const menuWidth = Math.min(350, width - 24);
    return <View style={styles.header} testID={`${testIDPrefix}-conversation-header`}>
        <Button ref={anchor} variant="toolbar" label={t('projectGoals.history')} expanded={open} disabled={busy} testID={`${testIDPrefix}-history`} onPress={() => {
            anchor.current?.measureInWindow((x, y, _w, h) => { setPosition({ x, y: y + h + 6 }); setOpen(true); onRefresh?.(); });
        }}><Ionicons name="time-outline" size={16} color={theme.colors.textSecondary} /><Text style={styles.meta}>{t('projectGoals.history')} · {sessions.length}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button>
        <View style={{ flex: 1 }} />
        {!mobile && onNew && <Button variant="toolbar" label={t('projectGoals.newChat')} disabled={busy || offline} testID={`${testIDPrefix}-new-chat`} onPress={create}><Ionicons name="add-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.newChat')}</Text></Button>}
        {open && <Modal transparent visible animationType="none" onRequestClose={close}>
            <HistoryEscape onClose={close} />
            <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={close} />
            <View testID={`${testIDPrefix}-history-menu`} style={[styles.menu, { width: menuWidth, maxHeight: mobile ? height * 0.7 : Math.max(100, Math.min(360, height - position.y - 16)), left: Math.max(12, Math.min(position.x, width - menuWidth - 12)), ...(mobile ? { bottom: 12 } : { top: Math.max(12, Math.min(position.y, height - 180)) }) }]}>
                <ScrollView style={styles.list}>
                    {mobile && onNew && <Button variant="toolbar" label={t('projectGoals.newChat')} disabled={busy || offline} testID={`${testIDPrefix}-new-chat`} onPress={create}><Ionicons name="add-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.newChat')}</Text></Button>}
                    {sessions.map(session => <Button key={session.sessionId} variant="row" label={session.title} selected={selectedId === session.sessionId} disabled={busy} testID={`${testIDPrefix}-history-${session.sessionId}`} onPress={() => { close(); onSelect(session.sessionId); }}><View style={styles.copy}><Text numberOfLines={2} style={styles.body}>{session.title}</Text><Text style={styles.meta}>{new Date(session.updatedAt).toLocaleString()}</Text></View></Button>)}
                    {loading && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                    {error && <><Text accessibilityRole="alert" style={styles.error}>{error}</Text>{onRetry && <Button label={t('common.retry')} onPress={onRetry}><Text style={styles.link}>{t('common.retry')}</Text></Button>}</>}
                    {onMore && <Button label={t('projectGoals.moreHistory')} disabled={loading} onPress={onMore}><Text style={styles.link}>{t('projectGoals.moreHistory')}</Text></Button>}
                    {!sessions.length && !loading && <Text style={styles.meta}>{t(onNew ? 'projectGoals.noHistory' : 'projectGoals.noMatchingHistory')}</Text>}
                </ScrollView>
            </View>
        </Modal>}
    </View>;
}
function HistoryEscape({ onClose }: { onClose: () => void }) { useProjectModalEscape(onClose); return null; }

const styles = StyleSheet.create(theme => ({
    header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    backdrop: { position: 'absolute', inset: 0 },
    menu: { position: 'absolute', borderRadius: 12, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, overflow: 'hidden', shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    list: { flexGrow: 0, padding: 8 }, copy: { flex: 1, minWidth: 0, gap: 8 },
    body: { fontSize: 13, lineHeight: 21, color: theme.colors.text, ...Typography.default() },
    meta: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    link: { fontSize: 12, lineHeight: 18, color: theme.colors.textLink, ...Typography.default('semiBold') },
    error: { fontSize: 12, lineHeight: 19, color: theme.colors.textDestructive },
}));
