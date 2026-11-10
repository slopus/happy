import * as React from 'react';
import { View, ScrollView, TextInput, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { sessionWorkspaceListDirectory, type DirectoryEntry } from '@/sync/ops';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useFileWorkspace } from './context';
import { WorkspaceButton as Button } from './WorkspaceButton';

export function WorkspaceDirectoryTree({ sessionId, rootPath, onOpenFile, listDirectory = sessionWorkspaceListDirectory }: {
    sessionId: string;
    rootPath?: string;
    onOpenFile?: (path: string) => void;
    listDirectory?: typeof sessionWorkspaceListDirectory;
}) {
    const workspace = useFileWorkspace();
    const { theme } = useUnistyles();
    const [directories, setDirectories] = React.useState<Record<string, { entries?: DirectoryEntry[]; error?: string }>>({});
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    const [query, setQuery] = React.useState('');
    const [hidden, setHidden] = React.useState(false);
    const requests = React.useRef(new Map<string, object>());
    const alive = React.useRef(true);
    const root = rootPath ?? workspace?.root ?? '';
    const canBrowse = Boolean(rootPath || workspace?.enabled);
    const load = React.useCallback(async (path: string) => {
        if (!accountRuntimeCurrent()) return;
        const token = {}; requests.current.set(path, token);
        setDirectories(value => ({ ...value, [path]: {} }));
        const result = await listDirectory(sessionId, path);
        if (!alive.current || !accountRuntimeCurrent() || requests.current.get(path) !== token) return;
        setDirectories(value => ({ ...value, [path]: result.success ? { entries: result.entries ?? [] } : { error: result.error ?? t('fileWorkspace.readError') } }));
    }, [sessionId, listDirectory]);
    React.useEffect(() => { alive.current = true; setDirectories({}); setExpanded(new Set()); if (canBrowse && root) void load(root); return () => { alive.current = false; requests.current.clear(); }; }, [root, load, canBrowse]);
    React.useEffect(() => {
        const active = workspace?.snapshot.active;
        if (!canBrowse || !root || !active?.startsWith(root + '/')) return;
        let parent = root;
        const parents = active.slice(root.length + 1).split('/').slice(0, -1).map(segment => { parent += '/' + segment; return parent; });
        setExpanded(value => new Set([...value, ...parents]));
        for (const path of parents) if (!requests.current.has(path)) void load(path);
    }, [workspace?.snapshot.active, root, load, canBrowse]);
    if (!canBrowse || !root) return <Text style={{ padding: 16, color: theme.colors.textSecondary }}>{t('fileWorkspace.rootUnavailable')}</Text>;
    const rows = (path: string, depth: number): React.ReactNode => {
        const directory = directories[path];
        if (!directory || (!directory.entries && !directory.error)) return <ActivityIndicator key={path} style={{ padding: 12 }} color={theme.colors.textSecondary} />;
        if (directory.error) return <View key={path} style={{ padding: 12 }}><Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{directory.error}</Text><Button label={t('common.retry')} onPress={() => { void load(path); }} /></View>;
        const entries = [...directory.entries!].filter(entry => entry.name !== '.' && entry.name !== '..' && !/[\\/]/.test(entry.name) && entry.type !== 'other' && (hidden || !entry.name.startsWith('.')))
            .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
        return entries.map(entry => {
            const full = path + '/' + entry.name;
            const isDirectory = entry.type === 'directory';
            const open = expanded.has(full);
            // Filtering is intentionally restricted to loaded folders; never scan the whole machine.
            if (!isDirectory && query && !full.toLowerCase().includes(query.toLowerCase())) return null;
            return <React.Fragment key={full}>
                <DirectoryRow name={entry.name} full={full} depth={depth} directory={isDirectory} open={open} selected={workspace?.snapshot.active === full} onPress={() => {
                    if (isDirectory) { setExpanded(value => { const next = new Set(value); if (open) next.delete(full); else next.add(full); return next; }); if (!open && !directories[full]) void load(full); }
                    else if (onOpenFile) onOpenFile(full);
                    else void workspace?.openReference(full);
                }} />
                {isDirectory && open && rows(full, depth + 1)}
            </React.Fragment>;
        });
    };
    return <View style={{ flex: 1 }} testID="workspace-directory-tree">
        <View style={{ flexDirection: 'row', padding: 8, alignItems: 'center' }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: theme.colors.textSecondary }}>{root.split('/').pop() || root}</Text>
            <Button label={hidden ? t('fileWorkspace.hideHidden') : t('fileWorkspace.hidden')} icon="eye-outline" compact selected={hidden} onPress={() => setHidden(!hidden)} />
            <Button label={t('fileWorkspace.refresh')} icon="refresh-outline" compact onPress={() => { for (const path of [root, ...expanded]) void load(path); }} />
            {!onOpenFile && workspace && !workspace.snapshot.open && workspace.snapshot.active && <Button label={t('fileWorkspace.open')} icon="open-outline" compact onPress={() => workspace.controller.setOpen(true)} />}
        </View>
        <TextInput value={query} onChangeText={setQuery} placeholder={t('fileWorkspace.filter')} accessibilityLabel={t('fileWorkspace.filter')} placeholderTextColor={theme.colors.textSecondary} style={{ color: theme.colors.text, backgroundColor: theme.colors.surface, borderRadius: 7, marginHorizontal: 10, padding: 8, fontSize: 12 }} />
        {query ? <Text style={{ padding: 10, fontSize: 11, color: theme.colors.textSecondary }}>{t('fileWorkspace.searchHint')}</Text> : null}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8 }}>{rows(root, 0)}</ScrollView>
    </View>;
}
function DirectoryRow({ name, full, depth, directory, open, selected, onPress }: { name: string; full: string; depth: number; directory: boolean; open: boolean; selected: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    const [hover, setHover] = React.useState(false);
    return <Pressable accessibilityRole="button" accessibilityLabel={full} accessibilityState={{ selected, expanded: directory ? open : undefined }} onPress={onPress}
        {...({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', padding: 8, paddingLeft: 12 + depth * 14, gap: 7, backgroundColor: selected ? theme.colors.surfaceSelected : hover || pressed ? theme.colors.surfacePressed : 'transparent' })}>
        <Ionicons name={directory ? open ? 'chevron-down-outline' : 'chevron-forward-outline' : 'document-text-outline'} size={15} color={theme.colors.textSecondary} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: theme.colors.text }}>{name}</Text>
    </Pressable>;
}
