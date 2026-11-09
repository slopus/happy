import * as React from 'react';
import { Platform } from 'react-native';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { useSession, useSocketStatus, useMachine } from '@/sync/storage';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { getServerUrl } from '@/sync/serverConfig';
import { loadFileWorkspaceUI, saveFileWorkspaceUI, loadFileWorkspaceDrafts, saveFileWorkspaceDrafts, loadFileWorkspaceReference, saveFileWorkspaceReference } from '@/sync/persistence';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { Modal } from '@/modal';
import { t } from '@/text';
import { artifactRequest, artifactInvalidations } from '@/sync/artifactWorkspace';
import { loadWorkspaceVersionOperations, saveWorkspaceVersionOperations } from '@/sync/persistence';
import { VersionController, type RestoreSelection } from './versionController';
import { FileWorkspaceController } from './controller';
import { EventRefreshQueue } from './eventRefreshQueue';
import { readWorkspaceText, writeWorkspaceText } from './fileIO';
import { FileWorkspaceContext, type FileReference } from './context';

export function SessionFileWorkspaceProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
    const session = useSession(sessionId);
    const root = session?.metadata?.path ?? '';
    const { rightPanelAvailable } = useDesktopWorkspaceLayout();
    const enabled = Platform.OS === 'web' && rightPanelAvailable;
    const scope = JSON.stringify([getServerUrl(), getRuntimeAccountSelection()?.key ?? 'legacy', session?.metadata?.machineId ?? sessionId, root, sessionId]);
    return <FileWorkspaceOwner key={scope + sessionId} {...{ sessionId, root, enabled, scope }}>{children}</FileWorkspaceOwner>;
}
function FileWorkspaceOwner({ sessionId, root, enabled, scope, children }: { sessionId: string; root: string; enabled: boolean; scope: string; children: React.ReactNode }) {
    const { status: socketStatus } = useSocketStatus();
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const versions = React.useMemo(() => new VersionController(root, (method, input) => artifactRequest(machineId, method, input), accountRuntimeCurrent, loadWorkspaceVersionOperations(scope), value => saveWorkspaceVersionOperations(scope, value)), [root, machineId, scope]);
    const versionSnapshot = React.useSyncExternalStore(versions.subscribe, versions.getSnapshot, versions.getSnapshot);
    const initial = React.useMemo(() => loadFileWorkspaceUI(scope), [scope]);
    const drafts = React.useRef(loadFileWorkspaceDrafts(scope));
    const controller = React.useMemo(() => new FileWorkspaceController({ root,
        read: async path => {
            const content = await readWorkspaceText(sessionId, path);
            if (machineId && /\.(md|markdown|html?)$/i.test(path)) {
                void versions.current(path).catch(() => {});
            }
            return content;
        },
        write: (path, content, hash) => {
            if (versions.state(path).pending) throw new Error(t('fileWorkspace.historyPending'));
            return versions.state(path).artifact ? versions.save(path, content, hash) : writeWorkspaceText(sessionId, path, content, hash);
        }, isCurrent: accountRuntimeCurrent,
    }), [sessionId, root, versions, machineId]);
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const eventRefresh = React.useMemo(() => new EventRefreshQueue(async path => {
        await controller.refresh(path);
        if (versions.state(path).artifact) await versions.load(path, false, false);
    }), [controller, versions]);
    const [draftCacheError, setDraftCacheError] = React.useState(false);
    const [referenceCacheError, setReferenceCacheError] = React.useState(false);
    const [reference, setReference] = React.useState<FileReference | null>(() => {
        const saved = loadFileWorkspaceReference(scope);
        const resolved = saved && resolveSessionFilePath(saved.path, root);
        return saved && resolved?.withinSessionRoot ? { ...saved, path: resolved.absolutePath } : null;
    });
    const [chatWidth, setChatWidth] = React.useState(initial.width);
    const [maximized, setMaximized] = React.useState(false);
    const [openRequestId, setOpenRequestId] = React.useState(0);
    const restored = React.useRef(false);
    const restoration = React.useMemo(() => {
        let finish!: () => void;
        const ready = new Promise<void>(resolve => { finish = resolve; });
        return { ready, finish };
    }, [controller]);
    const [restoring, setRestoring] = React.useState(true);
    React.useEffect(() => {
        if (!enabled || !root || socketStatus !== 'connected' || restored.current) return;
        restored.current = true;
        // Restore only previously opened tabs, bounded to twenty by persistence.
        const reads = initial.tabs.map(path => { const draft = drafts.current[path]; return controller.open(path).then(() => { if (draft) controller.restoreDraft(path, draft); }); });
        void Promise.allSettled(reads).then(() => { setRestoring(false); restoration.finish(); });
        if (initial.active) void controller.open(initial.active);
        if (!initial.open) controller.setOpen(false);
    }, [controller, enabled, initial, root, socketStatus, restoration]);
    const lifetime = React.useRef<object | null>(null);
    React.useEffect(() => {
        const token = {}; lifetime.current = token;
        return () => { queueMicrotask(() => { if (lifetime.current === token) {lifetime.current = null; eventRefresh.dispose(); controller.dispose(); versions.dispose(); restoration.finish();} }); };
    }, [controller, versions, eventRefresh, restoration]);
    React.useEffect(() => {
        if (restored.current && !restoring && accountRuntimeCurrent()) saveFileWorkspaceUI(scope, { tabs: snapshot.tabs, active: snapshot.active, open: snapshot.open, width: chatWidth });
    }, [scope, restoring, snapshot.tabs, snapshot.active, snapshot.open, chatWidth]);
    React.useEffect(() => {
        if (restoring || !restored.current || !accountRuntimeCurrent()) return;
        try { setDraftCacheError(!saveFileWorkspaceDrafts(scope, controller.exportDrafts())); } catch { setDraftCacheError(true); }
    }, [scope, restoring, snapshot, controller]);
    React.useEffect(() => {
        if (!enabled || !accountRuntimeCurrent()) return;
        try { saveFileWorkspaceReference(scope, reference); setReferenceCacheError(false); } catch { setReferenceCacheError(true); }
    }, [enabled, scope, reference]);
    const previousSocket = React.useRef(socketStatus);
    React.useEffect(() => {
        const reconnected = socketStatus === 'connected' && previousSocket.current !== 'connected';
        previousSocket.current = socketStatus;
        if (reconnected && restored.current && !restoring) eventRefresh.enqueue(controller.getSnapshot().tabs);
    }, [controller, socketStatus, eventRefresh]);
    const turn = session?.agentState?.turnStatus;
    const terminal = ['completed', 'cancelled', 'failed'].includes(turn?.status ?? '') ? `${turn?.turnId}:${turn?.updatedAt}` : null;
    const previousTurn = React.useRef(terminal);
    React.useEffect(() => {
        if (!terminal || previousTurn.current === terminal) return;
        previousTurn.current = terminal;
        eventRefresh.enqueue(controller.getSnapshot().tabs);
    }, [controller, sessionId, terminal, eventRefresh]);
    const changes = artifactInvalidations(machine?.daemonState);
    const changeSignature = JSON.stringify(changes);
    const seenChanges = React.useRef<Record<string, string>>({});
    React.useEffect(() => {
        for (const change of changes) {
            const key = change.workspaceId + ':' + change.artifactId;
            const revision = change.currentVersionId + ':' + change.workingRevision + ':' + change.sequence;
            if (seenChanges.current[key] === revision) continue;
            seenChanges.current[key] = revision;
            for (const path of controller.getSnapshot().tabs) {
                const a = versions.state(path).artifact;
                if (a?.workspaceId === change.workspaceId && a.id === change.artifactId && !versions.state(path).busy) eventRefresh.enqueue([path]);
            }
        }
    }, [changeSignature, controller, versions, eventRefresh]);
    const restoreVersion = React.useCallback(async (path: string, action?: 'inspect' | 'resume' | 'rollback' | 'retry', selection?: RestoreSelection) => {
        const doc = controller.getSnapshot().documents[path];
        if (!doc || doc.saving || (!action && doc.draft !== doc.content)) return false;
        setReference(value => value?.path === path ? null : value);
        const success = action === 'inspect' ? await versions.inspect(path) : action === 'retry' ? await versions.retryOperation(path) : action ? await versions.resolve(path, action) : await versions.restore(path, selection);
        if (success) {
            await controller.refresh(path);
            await versions.waitForCurrent(path).catch(() => null);
            const document = controller.getSnapshot().documents[path];
            const current = versions.currentForHash(path, document?.error ? null : document?.hash ?? null);
            const entry = current?.manifest.files.find(f => f.path === current.manifest.entryPath);
            if (current && entry && controller.getSnapshot().active === path) setReference({path,hash:entry.sha256,artifact:{workspaceId:current.artifact.workspaceId,artifactId:current.artifact.id,expectedRevision:current.workingRevision,...(current.readRef.kind === 'version' ? {versionId:current.readRef.versionId} : {})}});
        }
        return success;
    }, [controller, versions]);
    const openReference = React.useCallback(async (raw: string) => {
        if (!enabled || !root || !accountRuntimeCurrent()) return;
        let path = raw;
        if (!raw.includes('/') && !raw.includes('\\')) {
            const matches = controller.getSnapshot().tabs.filter(file => file.split('/').pop() === raw);
            if (matches.length > 1) { Modal.alert(t('fileWorkspace.title'), t('fileWorkspace.ambiguous')); return; }
            if (matches.length === 1) path = matches[0];
        }
        const resolved = resolveSessionFilePath(path, root);
        if (!resolved?.withinSessionRoot) { Modal.alert(t('fileWorkspace.title'), t('fileWorkspace.rootUnavailable')); return; }
        // Child navigation effects run before this owner's restoration effect.
        // Finish restoring every cached draft before a new tab can use a slot.
        await restoration.ready;
        if (!lifetime.current || !accountRuntimeCurrent()) return;
        setMaximized(false);
        setOpenRequestId(value => value + 1);
        try { await controller.open(resolved.absolutePath); } catch (error) { Modal.alert(t('fileWorkspace.title'), error instanceof Error && error.message === 'FILE_WORKSPACE_TAB_LIMIT' ? t('fileWorkspace.tooManyTabs') : String(error)); }
    }, [controller, enabled, root, sessionId, restoration]);
    return <FileWorkspaceContext.Provider value={{ sessionId, openRequestId, versions, versionSnapshot, restoreVersion, draftCacheError: draftCacheError || referenceCacheError, enabled, root, controller, snapshot, reference, setReference, openReference, chatWidth, setChatWidth, maximized, setMaximized }}>{children}</FileWorkspaceContext.Provider>;
}
