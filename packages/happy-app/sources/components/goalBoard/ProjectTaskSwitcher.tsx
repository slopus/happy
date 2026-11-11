import * as React from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalTask } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

/** Opening the task list is local UI state; the active file, chat and details stay mounted. */
export function ProjectTaskSwitcher({ tasks, selectedId, onSelect }: { tasks: GoalTask[]; selectedId: string; onSelect: (id: string) => void }) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const trigger = React.useRef<View>(null);
    const selected = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [anchor, setAnchor] = React.useState({ right: 0, bottom: 0 });
    const close = React.useCallback(() => {
        setOpen(false);
        queueMicrotask(() => trigger.current?.focus());
    }, []);
    React.useEffect(() => {
        if (!open || Platform.OS !== 'web') return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation(); close();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, close]);
    const menuWidth = Math.min(380, width - 24);
    const menuHeight = Math.max(120, Math.min(420, height - 24));
    const top = Math.max(12, Math.min(anchor.bottom + 6, height - menuHeight - 12));
    return <>
        <Button ref={trigger} variant="toolbar" label={t('projectGoals.backTasks')} expanded={open} testID="project-task-switcher" onPress={() => {
            trigger.current?.measureInWindow((x, y, w, h) => { setAnchor({ right: x + w, bottom: y + h }); setOpen(true); });
        }}><Ionicons name="grid-outline" size={15} color={theme.colors.textSecondary} /><Text style={styles.label}>{t('projectGoals.backTasks')}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button>
        {open && <Modal transparent visible animationType="none" onRequestClose={close} onShow={() => selected.current?.focus()}>
            <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={close} />
            <View testID="project-task-switcher-menu" style={[styles.menu, { width: menuWidth, maxHeight: menuHeight, top, left: Math.max(12, Math.min(anchor.right - menuWidth, width - menuWidth - 12)) }]}>
                <View style={styles.header}><Text style={styles.label}>{t('projectGoals.tasks')} · {tasks.length}</Text><Button variant="toolbar" label={t('common.cancel')} onPress={close}><Ionicons name="close-outline" size={16} color={theme.colors.textSecondary} /></Button></View>
                <ScrollView style={styles.list}>
                    {tasks.map(task => <Button key={task.id} ref={task.id === selectedId ? selected : undefined} variant="row" selected={task.id === selectedId} label={task.title} testID={`project-task-switch-${task.id}`} onPress={() => {
                        close();
                        if (task.id !== selectedId) onSelect(task.id);
                    }}><View style={styles.copy}><Text numberOfLines={2} style={styles.title}>{task.title}</Text><Text numberOfLines={2} style={styles.label}>{task.goal || task.title}</Text></View>{task.id === selectedId && <Ionicons name="checkmark" size={16} color={theme.colors.textLink} />}</Button>)}
                </ScrollView>
            </View>
        </Modal>}
    </>;
}

const styles = StyleSheet.create(theme => ({
    backdrop: { position: 'absolute', inset: 0 },
    menu: { position: 'absolute', borderRadius: 13, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface,
        overflow: 'hidden', shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    header: { minHeight: 42, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    list: { flexGrow: 0, padding: 6 },
    copy: { flex: 1, minWidth: 0, gap: 5 },
    title: { fontSize: 13, lineHeight: 20, color: theme.colors.text, ...Typography.default('semiBold') },
    label: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
}));
