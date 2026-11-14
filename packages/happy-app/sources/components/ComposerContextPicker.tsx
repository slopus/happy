import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { usePlugins } from '@/hooks/usePlugins';
import { getSessionName } from '@/utils/sessionUtils';
import { resolvePluginText } from './plugins/pluginText';
import { searchFiles, type FileItem } from '@/sync/suggestionFile';
import { t } from '@/text';
import type { KeyPressEvent } from './MultiTextInput';
import { contextPlugins, contextSessions, contextSites, filterContextItems, type ContextCategory, type ContextItem } from './autocomplete/contextItems';

export type ComposerContextPickerHandle = { handleKey: (event: KeyPressEvent) => boolean };
type Props = {
    query: string;
    sessionId?: string;
    onSelect: (text: string) => void;
    onPickFiles?: () => void;
    onClose: (restoreFocus?: boolean) => void;
};
const categories: ContextCategory[] = ['all', 'files', 'plugins', 'sites', 'sessions'];
const ROW_HEIGHT = Platform.OS === 'web' ? 34 : 44;

export const ComposerContextPicker = React.forwardRef<ComposerContextPickerHandle, Props>(function ComposerContextPicker(props, ref) {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const [category, setCategory] = React.useState<ContextCategory>('all');
    const [query, setQuery] = React.useState(props.query);
    const [selected, setSelected] = React.useState(0);
    const [files, setFiles] = React.useState<FileItem[]>([]);
    const [filesState, setFilesState] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [retry, setRetry] = React.useState(0);
    const { plugins, loading: pluginsLoading, status: pluginsStatus, refresh } = usePlugins();
    const sessions = storage(s => s.sessions);
    const histories = storage(s => s.sessionMessages);
    const scrollRef = React.useRef<ScrollView>(null);
    const rootRef = React.useRef<View>(null);
    React.useEffect(() => setQuery(props.query), [props.query]);
    // One request on opening/searching; no background status polling.
    React.useEffect(() => {
        if (pluginsStatus === 'idle') void refresh().catch(() => undefined);
    }, [pluginsStatus, refresh]);
    React.useEffect(() => {
        if (!props.sessionId || (category !== 'files' && !query.trim())) { setFiles([]); setFilesState('idle'); return; }
        let active = true;
        setFilesState('loading');
        setFiles([]);
        void searchFiles(props.sessionId, query, { limit: 30 }).then(result => {
            if (active) { setFiles(result); setFilesState('ready'); }
        }).catch(() => { if (active) { setFiles([]); setFilesState('error'); } });
        return () => { active = false; };
    }, [props.sessionId, category, query, retry]);
    const pluginItems = React.useMemo(() => contextPlugins(plugins, resolvePluginText), [plugins]);
    const siteItems = React.useMemo(() => contextSites(histories), [histories]);
    const sessionItems = React.useMemo(() => contextSessions(sessions, props.sessionId, getSessionName), [sessions, props.sessionId]);
    const items = React.useMemo(() => {
        const all: ContextItem[] = [];
        if (props.onPickFiles) all.push({ id: 'upload', category: 'files', title: t('composerContext.upload'), detail: t('composerContext.uploadHint'), text: '', icon: 'attach-outline', action: 'upload' });
        all.push(...files.map(file => ({ id: `file:${file.fullPath}`, category: 'files' as const, title: file.fileName, detail: file.filePath, text: `@${file.fullPath}`, icon: file.fileType === 'folder' ? 'folder-outline' as const : 'document-text-outline' as const })));
        all.push(...pluginItems, ...siteItems, ...sessionItems);
        return filterContextItems(all, category, query).slice(0, query.trim() ? 60 : 30);
    }, [files, pluginItems, siteItems, sessionItems, props.onPickFiles, category, query]);
    React.useEffect(() => setSelected(0), [category, query]);
    const safeSelected = Math.min(selected, Math.max(0, items.length - 1));
    React.useEffect(() => { scrollRef.current?.scrollTo({ y: Math.max(0, safeSelected - 3) * ROW_HEIGHT, animated: false }); }, [safeSelected]);
    const select = React.useCallback((index: number) => {
        const item = items[index];
        if (!item) return;
        if (item.action === 'upload') { props.onSelect(''); props.onPickFiles?.(); }
        else props.onSelect(item.text);
    }, [items, props.onSelect, props.onPickFiles]);
    const handleKey = React.useCallback((event: KeyPressEvent) => {
        if (event.key === 'Escape') { props.onClose(); return true; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
            // Typing/caret movement in the composer remains inside the same interaction.
            if (node && !node.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('[data-testid="message-composer-content"]')) props.onClose(false);
        };
        document.addEventListener('mousedown', outside);
        return () => document.removeEventListener('mousedown', outside);
    }, [props.onClose]);
    const loading = (category === 'files' && filesState === 'loading') || (category === 'plugins' && pluginsLoading);
    const failed = (category === 'files' && filesState === 'error') || (category === 'plugins' && pluginsStatus === 'error');
    return <View ref={rootRef} style={[styles.container, { maxHeight: Math.max(160, Math.min(400, height * 0.6)) }]} testID="composer-context-picker">
        <View style={styles.heading}>
            <Text style={styles.title}>{t('composerContext.title')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('composerContext.close')} onPress={() => props.onClose()} hitSlop={8}><Ionicons name="close" size={17} color={theme.colors.textSecondary} /></Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.tabs} contentContainerStyle={{ gap: 3 }}>
            {categories.map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: value === category }} testID={`composer-context-tab-${value}`} onPress={() => setCategory(value)} style={({ pressed }) => [styles.tab, { backgroundColor: value === category ? theme.colors.surfaceSelected : pressed ? theme.colors.surfacePressed : theme.colors.surface }]}>
                <Text style={[styles.tabText, { color: value === category ? theme.colors.text : theme.colors.textSecondary }]}>{t(`composerContext.${value}`)}</Text>
            </Pressable>)}
        </ScrollView>
        <View style={styles.searchRow}>
            <Ionicons name="search-outline" size={15} color={theme.colors.textSecondary} />
            <TextInput value={query} onChangeText={setQuery} placeholder={t('composerContext.search')} placeholderTextColor={theme.colors.input.placeholder} accessibilityLabel={t('composerContext.search')} style={styles.search} testID="composer-context-search"
                {...(Platform.OS === 'web' ? { onKeyPress: (rawEvent: unknown) => { const event = rawEvent as React.KeyboardEvent; if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (handleKey({ key: event.key, shiftKey: event.shiftKey } as KeyPressEvent)) { event.preventDefault(); event.stopPropagation(); } } } : {})} />
        </View>
        <ScrollView ref={scrollRef} style={styles.results} keyboardShouldPersistTaps="handled" testID="composer-context-results">
            {items.map((item, index) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.detail}`} accessibilityState={{ selected: safeSelected === index }} testID={`composer-context-item-${item.id}`} onHoverIn={() => setSelected(index)} onPress={() => select(index)} style={({ pressed }) => [styles.row, { height: ROW_HEIGHT, backgroundColor: pressed ? theme.colors.surfacePressed : safeSelected === index ? theme.colors.surfaceSelected : theme.colors.surface }]}>
                <Ionicons name={item.icon} size={16} color={theme.colors.textSecondary} />
                <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
                <Text numberOfLines={1} style={styles.detail}>{item.detail || t(`composerContext.${item.category}`)}</Text>
            </Pressable>)}
            {loading && <View style={styles.empty}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.detail}>{t('composerContext.loading')}</Text></View>}
            {failed && <Pressable style={styles.empty} onPress={() => { setRetry(v => v + 1); if (category === 'plugins') void refresh().catch(() => undefined); }}><Text style={styles.detail}>{t('composerContext.unavailable')} · {t('composerContext.retry')}</Text></Pressable>}
            {!items.length && !loading && !failed && <Text style={styles.emptyText}>{t(category === 'sites' && !query ? 'composerContext.emptySites' : 'composerContext.empty')}</Text>}
        </ScrollView>
        <Text style={styles.footer}>{t('composerContext.referenceHint')}</Text>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    container: { flexShrink: 1, width: '100%', maxWidth: 580, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, padding: 6, overflow: 'hidden', shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 4 }, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 16, elevation: 8 },
    heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 6 },
    title: { fontSize: 12, fontWeight: '600', color: theme.colors.textSecondary },
    tabs: { flexGrow: 0, flexShrink: 0, marginBottom: 5 },
    tab: { borderRadius: 7, paddingHorizontal: 9, paddingVertical: 6 },
    tabText: { fontSize: 12 },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, paddingHorizontal: 8 },
    search: { flex: 1, minWidth: 0, fontSize: 12, color: theme.colors.text, paddingVertical: 8, ...(Platform.OS === 'web' ? { outlineWidth: 0 } : {}) },
    results: { flexShrink: 1, maxHeight: 272 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 7 },
    itemTitle: { fontSize: 13, color: theme.colors.text, flexShrink: 1 },
    detail: { fontSize: 11, color: theme.colors.textSecondary, flexShrink: 1, marginLeft: 'auto', maxWidth: '48%' },
    empty: { alignItems: 'center', justifyContent: 'center', gap: 8, flexDirection: 'row', padding: 14 },
    emptyText: { color: theme.colors.textSecondary, fontSize: 12, padding: 16, lineHeight: 18 },
    footer: { fontSize: 10, color: theme.colors.textSecondary, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 3 },
}));
