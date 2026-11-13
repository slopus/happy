import * as React from 'react';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { loadGoalProjects, loadProjectGoalBoard } from '@/sync/projectGoals';
import { isProjectSessionDeleted } from '@/sync/projectSessionLinks';
import { findSessionWorkspace, sessionWorkspaceRoute, type WorkspaceSessionMetadata } from '@/utils/sessionWorkspaceRoute';
import { Modal } from '@/modal';
import { t } from '@/text';
import { GoalBoardButton } from './GoalBoardButton';

/** One focus/user-triggered read, fenced against session, account and focus changes. */
export function SessionWorkspaceLink({ id, metadata, embedded = false, focused, compact = true, floating = false, beforeNavigate }: {
    id: string; metadata?: WorkspaceSessionMetadata | null; embedded?: boolean; focused: boolean; compact?: boolean; floating?: boolean;
    beforeNavigate: () => void;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const owner = getRuntimeAccountSelection();
    const key = JSON.stringify([owner, id, metadata?.machineId, metadata?.path, metadata?.goalBoard?.featurePath, metadata?.goalBoard?.taskId, embedded, focused]);
    const context = React.useRef(key); context.current = key;
    const flushDraft = React.useRef(beforeNavigate); flushDraft.current = beforeNavigate;
    const epoch = React.useRef(0);
    const [state, setState] = React.useState({ key, candidate: false, busy: false });
    const read = React.useCallback(async (navigate: boolean) => {
        if (context.current !== key || !focused || embedded || !metadata?.machineId || !accountRuntimeCurrent()) return;
        const request = ++epoch.current;
        const current = () => context.current === key && epoch.current === request && accountRuntimeCurrent() && getRuntimeAccountSelection() === owner;
        setState(previous => ({ key, candidate: previous.key === key && previous.candidate, busy: true }));
        try {
            if (isProjectSessionDeleted(id)) throw new Error(t('projectGoals.sessionUnavailable'));
            const projects = await loadGoalProjects(metadata.machineId);
            if (!current()) return;
            const candidate = !!findSessionWorkspace(metadata, projects);
            setState({ key, candidate, busy: true });
            const route = await sessionWorkspaceRoute(id, metadata, projects, loadProjectGoalBoard);
            if (!current()) return;
            setState({ key, candidate: !!route, busy: true });
            if (navigate) {
                if (!route) throw new Error(t('projectGoals.sessionUnavailable'));
                flushDraft.current();
                router.navigate(route);
            }
        } catch (error) {
            if (navigate && current()) Modal.alert(t('projectGoals.sessionUnavailable'), error instanceof Error ? error.message : String(error));
        } finally {
            if (current()) setState(previous => ({ ...previous, busy: false }));
        }
    }, [key]);
    React.useEffect(() => {
        void read(false);
        return () => { epoch.current++; };
    }, [read]);
    if (!embedded && (!metadata?.machineId || (!metadata.goalBoard && !(state.key === key && state.candidate)))) return null;
    const label = t(embedded ? 'projectGoals.openOrdinaryChat' : 'projectGoals.openWorkspace');
    return <GoalBoardButton testID={embedded ? 'project-open-ordinary-chat' : 'session-open-project-workspace'} label={label} tooltip={label}
        variant={floating ? 'chip' : 'toolbar'} disabled={!focused || (!embedded && state.key === key && state.busy)} onPress={() => {
            if (context.current !== key || !focused || !accountRuntimeCurrent() || getRuntimeAccountSelection() !== owner) return;
            // Bypass the sidebar's phone routing policy: this action explicitly opens the ordinary page.
            if (embedded) { flushDraft.current(); router.navigate(`/session/${encodeURIComponent(id)}`); }
            else void read(true);
        }}>
        <Ionicons name={embedded ? 'open-outline' : 'compass-outline'} size={17} color={theme.colors.textLink} />
        {!compact && <Text numberOfLines={1} style={{ color: theme.colors.textLink, fontSize: 12 }}>{label}</Text>}
    </GoalBoardButton>;
}
