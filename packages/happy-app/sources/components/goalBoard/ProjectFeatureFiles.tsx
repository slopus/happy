import * as React from 'react';
import { Modal, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { projectFeatureFiles, projectGoalRequest } from '@/sync/projectGoals';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { useMachine } from '@/sync/storage';
import type { DirectoryEntry } from '@/sync/ops';
import { SessionFileWorkspaceProvider } from '@/components/fileWorkspace/SessionFileWorkspaceProvider';
import { ProjectArchiveTree } from './ProjectArchiveTree';
import { FileWorkspace } from '@/components/fileWorkspace/FileWorkspace';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';

export function ProjectFeatureFiles(props: { machineId: string; featurePath: string; title: string; onClose: () => void }) {
    const binding = React.useMemo(() => projectFeatureFiles(props.machineId, props.featurePath), [props.machineId, props.featurePath]);
    return <SessionFileWorkspaceProvider sessionId="" binding={binding}><FeatureFilesContent {...props} /></SessionFileWorkspaceProvider>;
}
function FeatureFilesContent({ machineId, featurePath, title, onClose }: { machineId: string; featurePath: string; title: string; onClose: () => void }) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const workspace = useFileWorkspace()!;
    useProjectModalEscape(onClose);
    const machine = useMachine(machineId);
    const [treeOpen, setTreeOpen] = React.useState(true);
    React.useEffect(() => { void workspace.openReference(`${featurePath}/index.md`); }, [featurePath, workspace.openReference]);
    const revision = (machine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    const listDirectory = React.useCallback(async (_id: string, path: string) => {
        try { return await projectGoalRequest<{ success: boolean; entries?: DirectoryEntry[]; error?: string }>(machineId, 'goalFeatureListDirectory', { featurePath, path }); }
        catch (error) { return { success: false, error: String(error) }; }
    }, [machineId, featurePath]);
    const narrow = width < 850;
    return <Modal visible transparent animationType="none" onRequestClose={onClose}><View style={styles.backdrop}><View style={[styles.dialog, { width: width - 32, height: height - 48 }]} testID="project-feature-files-panel">
        <View style={styles.header}><Text numberOfLines={1} style={styles.title}>{title} · {t('projectGoals.featureFiles')}</Text><Button label={t('projectGoals.featureFiles')} selected={treeOpen} onPress={() => setTreeOpen(value => !value)}><Text style={styles.link}>{t('projectGoals.featureFiles')}</Text></Button><Button label={t('common.back')} onPress={onClose}><Text style={styles.link}>{t('common.back')}</Text></Button></View>
        <View style={styles.row}>
            {treeOpen && <View style={[styles.tree, { width: narrow ? '100%' : 300 }]}><ProjectArchiveTree machineId={machineId} scopePath={featurePath} sessionId="" rootPath={featurePath} listDirectory={listDirectory} revision={revision} cacheKey={JSON.stringify([getRuntimeAccountSelection(), machineId, featurePath, 'feature'])} onOpenFile={path => { void workspace.openReference(path); if (narrow) setTreeOpen(false); }} /></View>}
            {(!narrow || !treeOpen) && <View style={styles.document}>{workspace.snapshot.open ? <FileWorkspace framed sessionId="" fileTreeExpanded={treeOpen} onToggleFileTree={() => setTreeOpen(value => !value)} /> : <View style={styles.empty}><Text style={{ color: theme.colors.textSecondary }}>{t('fileWorkspace.empty')}</Text></View>}</View>}
        </View>
    </View></View></Modal>;
}
const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop },
    dialog: { maxWidth: 1600, overflow: 'hidden', borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    header: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    title: { flex: 1, fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
    link: { fontSize: 12, color: theme.colors.textLink, ...Typography.default() }, row: { flex: 1, flexDirection: 'row' },
    tree: { flexShrink: 0 }, document: { flex: 1, minWidth: 0 }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
}));
