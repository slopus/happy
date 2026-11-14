import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { usePlugins } from '@/hooks/usePlugins';
import { getSessionName } from '@/utils/sessionUtils';
import { resolvePluginText } from './plugins/pluginText';
import { searchFiles, type FileItem } from '@/sync/suggestionFile';
import { t } from '@/text';
import type { KeyPressEvent } from './MultiTextInput';
import { contextPlugins, contextSessions, contextSites, filterContextItems, type ContextItem } from './autocomplete/contextItems';

export type ComposerContextPickerHandle = { handleKey: (event: KeyPressEvent) => boolean };
type Props = {
    query: string;
    sessionId?: string;
    onSelect: (item: ContextItem) => void;
    onPickFiles?: () => void;
    onClose: (restoreFocus?: boolean) => void;
};
const ROW_HEIGHT = Platform.OS === 'web' ? 34 : 44;
const groups = ['files', 'plugins', 'sites', 'sessions'] as const;
export const ComposerContextPicker = React.forwardRef<ComposerContextPickerHandle, Props>(function ComposerContextPicker(props, ref) {
    const { theme } = useUnistyles();
    const [selected, setSelected] = React.useState(0);
    const [files, setFiles] = React.useState<FileItem[]>([]);
    const [filesLoading, setFilesLoading] = React.useState(false);
    const { plugins, loading: pluginsLoading, status: pluginsStatus, refresh } = usePlugins();
    const sessions = storage(s => s.sessions);
    const histories = storage(s => s.sessionMessages);
    const scrollRef = React.useRef<ScrollView>(null);
    const rootRef = React.useRef<View>(null);
    const rowOffsets = React.useRef(new Map<string, number>());
    const keyboardSelection = React.useRef(false);
    React.useEffect(() => {
        if (pluginsStatus === 'idle') void refresh().catch(() => undefined);
    }, [pluginsStatus, refresh]);
    React.useEffect(() => {
        let active = true;
        setFiles([]);
        if (!props.sessionId || !props.query.trim()) { setFilesLoading(false); return; }
        setFilesLoading(true);
        void searchFiles(props.sessionId, props.query, { limit: 20 }).then(result => {
            if (active) setFiles(result);
        }).finally(() => { if (active) setFilesLoading(false); }).catch(() => undefined);
        return () => { active = false; };
    }, [props.sessionId, props.query]);
    const pluginItems = React.useMemo(() => contextPlugins(plugins, resolvePluginText), [plugins]);
    const siteItems = React.useMemo(() => contextSites(histories), [histories]);
    const sessionItems = React.useMemo(() => contextSessions(sessions, props.sessionId, getSessionName), [sessions, props.sessionId]);
    const items = React.useMemo(() => {
        const all: ContextItem[] = [];
        if (props.onPickFiles) all.push({ id: 'upload', category: 'files', title: t('composerContext.files'), detail: t('composerContext.uploadHint'), text: '', icon: 'attach-outline', action: 'upload' });
        all.push(...files.map(file => ({ id: `file:${file.fullPath}`, category: 'files' as const, title: file.fileName, detail: file.filePath, text: `@${file.fullPath}`, icon: file.fileType === 'folder' ? 'folder-outline' as const : 'document-text-outline' as const })));
        all.push(...pluginItems, ...siteItems, ...sessionItems);
        return filterContextItems(all, 'all', props.query).slice(0, props.query.trim() ? 60 : 30);
    }, [files, pluginItems, siteItems, sessionItems, props.onPickFiles, props.query]);
    React.useEffect(() => { keyboardSelection.current = false; setSelected(0); }, [props.query]);
    const safeSelected = Math.min(selected, Math.max(0, items.length - 1));
    // Hover only changes the highlight. Scroll-to-selection is exclusively a
    // keyboard action, and only when the row is outside the visible window.
    React.useLayoutEffect(() => {
        if (!keyboardSelection.current) return;
        keyboardSelection.current = false;
        const top = rowOffsets.current.get(items[safeSelected]?.id);
        if (top === undefined) return;
        const view = scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement; scrollTo?: (p: { y: number; animated: boolean }) => void };
        const node = view?.getScrollableNode?.();
        if (node) {
            if (top < node.scrollTop) node.scrollTop = top;
            else if (top + ROW_HEIGHT > node.scrollTop + node.clientHeight) node.scrollTop = top + ROW_HEIGHT - node.clientHeight;
        } else view?.scrollTo?.({ y: top, animated: false });
    }, [safeSelected, items]);
    const select = React.useCallback((index: number) => {
        const item = items[index];
        if (!item) return;
        props.onSelect(item);
        if (item.action === 'upload') props.onPickFiles?.();
    }, [items, props.onSelect, props.onPickFiles]);
    const handleKey = React.useCallback((event: KeyPressEvent) => {
        if (event.key === 'Escape') { props.onClose(); return true; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            keyboardSelection.current = true;
            setSelected((safeSelected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % (items.length || 1)); return true;
        }
        if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) { if (items.length) select(safeSelected); return true; }
        return false;
    }, [items.length, safeSelected, select, props.onClose]);
    React.useImperativeHandle(ref, () => ({ handleKey }), [handleKey]);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const outside = (event: MouseEvent) => {
            const node = rootRef.current as unknown as HTMLElement;
            if (node && !node.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('[data-testid="message-composer-content"]')) props.onClose(false);
        };
        document.addEventListener('mousedown', outside);
        return () => document.removeEventListener('mousedown', outside);
    }, [props.onClose]);
    let offset = 0;
    rowOffsets.current.clear();
    return <View ref={rootRef} style={styles.container} testID="composer-context-picker">
        <ScrollView ref={scrollRef} style={styles.results} keyboardShouldPersistTaps="handled" testID="composer-context-results" showsVerticalScrollIndicator>
            {groups.map(group => {
                const rows = items.filter(item => item.category === group);
                if (!rows.length) return null;
                offset += 26;
                return <View key={group}>
                    <Text style={styles.heading} testID={`composer-context-group-${group}`}>{t(group === 'files' ? 'composerContext.addGroup' : group === 'sessions' ? 'composerContext.conversationsGroup' : `composerContext.${group}`)}</Text>
                    {rows.map(item => {
                        const index = items.indexOf(item);
                        rowOffsets.current.set(item.id, offset); offset += ROW_HEIGHT;
                        return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.detail}`} accessibilityState={{ selected: safeSelected === index }} testID={`composer-context-item-${item.id}`}
                            onHoverIn={() => { keyboardSelection.current = false; setSelected(index); }} onPress={() => select(index)}
                            style={({ pressed }) => [styles.row, { height: ROW_HEIGHT, backgroundColor: pressed ? theme.colors.surfacePressed : safeSelected === index ? theme.colors.surfaceSelected : theme.colors.surface }]}>
                            <Ionicons name={item.icon} size={16} color={theme.colors.textSecondary} />
                            <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
                            {!!item.detail && <Text numberOfLines={1} style={styles.detail}>{item.detail}</Text>}
                        </Pressable>;
                    })}
                </View>;
            })}
            {(filesLoading || pluginsLoading) && <View style={styles.empty}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.emptyText}>{t('composerContext.loading')}</Text></View>}
            {pluginsStatus === 'error' && <Pressable style={styles.empty} onPress={() => { void refresh().catch(() => undefined); }}><Text style={styles.emptyText}>{t('composerContext.unavailable')} · {t('composerContext.retry')}</Text></Pressable>}
            {!items.length && !filesLoading && !pluginsLoading && <Text style={styles.emptyText}>{t('composerContext.empty')}</Text>}
        </ScrollView>
    </View>;
});
const styles = StyleSheet.create(theme => ({
    container: { flexShrink: 1, width: '100%', borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, padding: 6, overflow: 'hidden', shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 4 }, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 16, elevation: 8 },
    results: { flexShrink: 1, maxHeight: 388, ...(Platform.OS === 'web' ? { scrollbarWidth: 'thin' as const } : {}) },
    heading: { height: 26, paddingHorizontal: 8, paddingTop: 5, fontSize: 12, color: theme.colors.textSecondary, fontWeight: '600' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 7 },
    itemTitle: { fontSize: 13, color: theme.colors.text, flexShrink: 1, maxWidth: '70%' },
    detail: { fontSize: 11, color: theme.colors.textSecondary, flexShrink: 1, marginLeft: 'auto', maxWidth: '44%' },
    empty: { alignItems: 'center', justifyContent: 'center', gap: 8, flexDirection: 'row', padding: 10 },
    emptyText: { color: theme.colors.textSecondary, fontSize: 12, padding: 10, lineHeight: 18 },
}));
