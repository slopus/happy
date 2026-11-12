import * as React from 'react';
import { Modal, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectLibraryEntry } from '@/sync/projectLibrary';
import { projectSavedFileBinding } from '@/sync/projectGoals';
import { SessionFileWorkspaceProvider } from '@/components/fileWorkspace/SessionFileWorkspaceProvider';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { FileWorkspace } from '@/components/fileWorkspace/FileWorkspace';
import { MobileProjectFileReader } from './MobileProjectFileReader';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { LibraryItemActions } from './LibraryItemActions';
import { useLibraryItems } from '@/hooks/useLibraryItems';
import { t } from '@/text';

export function ProjectSavedFile({ machineId, item, onClose }: { machineId: string; item: ProjectLibraryEntry; onClose: () => void }) {
    const root = item.rootPath ?? item.scopePath ?? '';
    const binding = React.useMemo(() => projectSavedFileBinding(machineId, item.scopePath ?? '', root, item.taskId), [machineId, item.scopePath, root, item.taskId]);
    return <SessionFileWorkspaceProvider sessionId="" binding={binding}><SavedFileContent {...{ machineId, item, onClose }} /></SessionFileWorkspaceProvider>;
}
function SavedFileContent({ machineId, item, onClose }: { machineId: string; item: ProjectLibraryEntry; onClose: () => void }) {
    const workspace = useFileWorkspace()!;
    const library = useLibraryItems(machineId);
    const { width, height } = useWindowDimensions();
    const { theme } = useUnistyles();
    useProjectModalEscape(onClose);
    React.useEffect(() => { void workspace.openReference(item.projectPath); }, [workspace.openReference, item.projectPath]);
    return <Modal visible transparent animationType="none" onRequestClose={onClose}><View style={{ flex: 1, padding: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop }}><View style={{ width: '100%', maxWidth: 1500, height: height - 32, borderRadius: 14, overflow: 'hidden', backgroundColor: theme.colors.surface }} testID="project-saved-file">
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 }}><Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text }}>{item.title ?? item.projectPath.split('/').pop()}</Text><LibraryItemActions target={item} library={library} /><Button label={t('common.back')} onPress={onClose}><Text style={{ color: theme.colors.textLink }}>{t('common.back')}</Text></Button></View>
        {Platform.OS === 'web' && width >= 850 ? <FileWorkspace sessionId="" framed /> : <MobileProjectFileReader path={item.projectPath} scope={JSON.stringify([machineId, item.scopePath, item.taskId])} />}
    </View></View></Modal>;
}
