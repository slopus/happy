import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ProjectLibraryEntry } from '@/sync/projectLibrary';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { LibraryItemActions } from './LibraryItemActions';
import type { useLibraryItems } from '@/hooks/useLibraryItems';
import { projectGalleryColumns } from './ProjectGallery';

export function ProjectSavedItems({ items, library, onOpen, compact = false }: { items: ProjectLibraryEntry[]; library: ReturnType<typeof useLibraryItems>; onOpen: (item: ProjectLibraryEntry) => void; compact?: boolean }) {
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState(0);
    const columns = projectGalleryColumns(width);
    const grid = compact ? Platform.OS === 'web' ? { display: 'grid', gap: 12, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } as any : { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 12 } : undefined;
    return <View onLayout={event => setWidth(Math.floor(event.nativeEvent.layout.width))} style={[styles.list, grid]} testID="project-saved-items">{items.map(item => <View key={JSON.stringify([item.kind, item.projectPath])} style={[styles.item, compact && Platform.OS !== 'web' && { width: width ? (width - (columns - 1) * 12) / columns : 260 }]} testID={`saved-item-${item.kind}-${item.projectPath}`}>
        <View style={{ flex: 1, minWidth: 0 }}><Button variant="row" label={item.title ?? item.projectPath.split('/').pop() ?? item.projectPath} disabled={item.state !== 'active'} onPress={() => onOpen(item)}>
            <Ionicons name={item.kind === 'file' ? 'document-text-outline' : 'folder-open-outline'} size={20} color={theme.colors.textLink} />
            <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={styles.title}>{item.title ?? item.projectPath.split('/').pop()}</Text><Text numberOfLines={1} style={styles.meta}>{item.kind === 'project' ? item.projectPath.split('/').pop() : `${t(item.kind === 'file' ? 'projectGoals.savedDocument' : 'projectGoals.subprojects')} · ${item.projectPath.split('/').slice(-3, -1).join(' / ')}`}</Text></View>
        </Button></View>
        <LibraryItemActions target={item} library={library} />
    </View>)}</View>;
}
const styles = StyleSheet.create(theme => ({
    list: { gap: 8, width: '100%' },
    item: { flexDirection: 'row', alignItems: 'center', paddingRight: 6, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    title: { color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    meta: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
}));
