import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { WorkspaceDirectoryTree } from '@/components/fileWorkspace/WorkspaceDirectoryTree';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { LibraryItemActions } from './LibraryItemActions';
import { ProjectSavedItems } from './ProjectSavedItems';
import { useLibraryItems, type LibraryTarget } from '@/hooks/useLibraryItems';

export function ProjectArchiveTree({ machineId, scopePath, taskId, ...props }: React.ComponentProps<typeof WorkspaceDirectoryTree> & { machineId: string; scopePath: string; taskId?: string }) {
    const { theme } = useUnistyles();
    const workspace = useFileWorkspace();
    const library = useLibraryItems(machineId);
    const root = props.rootPath ?? workspace?.root ?? scopePath;
    const [deleted, setDeleted] = React.useState(false);
    const target = (path: string): LibraryTarget => ({ kind: 'file', projectPath: path, title: path.split('/').pop(), scopePath, rootPath: root, taskId });
    const saved = library.items.filter(item => item.kind === 'file' && item.projectPath.startsWith(root + '/') && (deleted ? item.state === 'deleted' : item.state === 'active' && item.favorite));
    const open = (path: string) => { if (props.onOpenFile) props.onOpenFile(path); else void workspace?.openReference(path); };
    return <View style={{ flex: 1, minHeight: 0 }} testID="project-archive-tree">
        <View style={{ flexDirection: 'row', gap: 6, padding: 8, flexWrap: 'wrap' }}><Button variant="chip" selected={!deleted} label={t('projectGoals.files')} onPress={() => setDeleted(false)}><Text style={{ color: theme.colors.text }}>{t('projectGoals.files')}</Text></Button><Button variant="chip" selected={deleted} label={t('projectGoals.deletedProjects')} onPress={() => setDeleted(true)} testID="file-filter-deleted"><Text style={{ color: theme.colors.text }}>{t('projectGoals.deletedProjects')}</Text></Button></View>
        {deleted ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 8, gap: 8 }}><ProjectSavedItems items={saved} library={library} onOpen={item => open(item.projectPath)} />{!saved.length && <Text style={{ padding: 12, color: theme.colors.textSecondary }}>{t('projectGoals.noDeletedFiles')}</Text>}</ScrollView> : <>
            {!!saved.length && <View style={{ maxHeight: 180, padding: 8, gap: 6 }}><Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{t('projectGoals.favorites')}</Text><ScrollView><ProjectSavedItems items={saved} library={library} onOpen={item => open(item.projectPath)} /></ScrollView></View>}
            <WorkspaceDirectoryTree {...props} includeFile={path => library.stateOf(target(path))?.state !== 'deleted'} renderFileActions={path => <LibraryItemActions target={target(path)} library={library} />} />
        </>}
    </View>;
}
