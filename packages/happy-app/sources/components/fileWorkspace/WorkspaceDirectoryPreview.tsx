import * as React from 'react';
import { ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import type { DirectoryEntry } from '@/sync/ops';
import { t } from '@/text';
import { WorkspaceTreeRow } from './WorkspaceTreeRow';
import { WorkspaceButton } from './WorkspaceButton';

/** Directory links stay in the file workspace and open children by full path. */
export function WorkspaceDirectoryPreview({ path, entries, onOpen, onMotionProject }: {
    path: string; entries: DirectoryEntry[]; onOpen: (path: string) => void; onMotionProject?: () => void;
}) {
    const { theme } = useUnistyles();
    const children = entries.filter(entry => entry.name && entry.name !== '.' && entry.name !== '..' && !/[\\/]/.test(entry.name) && entry.type !== 'other')
        .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    return <ScrollView testID="workspace-directory-preview" style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8 }}>
        {onMotionProject && entries.some(entry => entry.name === 'mh.json' && entry.type === 'file') && <WorkspaceButton label={t('motionWorkbench.open')} icon="film-outline" testID="directory-open-motion" onPress={onMotionProject} />}
        {children.length === 0 ? <Text style={{ padding: 16, color: theme.colors.textSecondary }}>{t('fileWorkspace.emptyDirectory')}</Text> : children.map(entry => {
            const fullPath = path.replace(/\/$/, '') + '/' + entry.name;
            return <WorkspaceTreeRow key={fullPath} title={entry.name} label={fullPath}
                icon={entry.type === 'directory' ? 'folder-outline' : 'document-text-outline'}
                onPress={() => onOpen(fullPath)} />;
        })}
    </ScrollView>;
}
