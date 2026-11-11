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

export type FileWorkspaceBinding = {
    root: string; scope: string; machineId: string;
    readOnly?: boolean;
    readBytes: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
    readText: (path: string, signal?: AbortSignal) => Promise<{ content: string; hash: string; media?: import('./controller').FileDocument['media']; fileRevision?: string }>;
    writeText: (path: string, content: string, hash: string) => Promise<{ hash: string; fileRevision?: string }>;
};
export function SessionFileWorkspaceProvider({ sessionId, binding, children }: { sessionId: string; binding?: FileWorkspaceBinding; children: React.ReactNode }) {
    const session = useSession(sessionId);
    const root = binding?.root ?? session?.metadata?.path ?? '';
    const { rightPanelAvailable } = useDesktopWorkspaceLayout();
    const enabled = !!binding || (Platform.OS === 'web' && rightPanelAvailable);
    const scope = JSON.stringify([getServerUrl(), getRuntimeAccountSelection()?.key ?? 'legacy', binding?.machineId ?? session?.metadata?.machineId ?? sessionId, root, binding?.scope ?? sessionId]);
    return <FileWorkspaceOwner key={scope} {...{ sessionId, root, enabled, scope, binding }}>{children}</FileWorkspaceOwner>;
}
function FileWorkspaceOwner({ sessionId, root, enabled, scope, binding, children }: { sessionId: string; root: string; enabled: boolean; scope: string; binding?: FileWorkspaceBinding; children: React.ReactNode }) {
    const { status: socketStatus } = useSocketStatus();
    const session = useSession(sessionId);
    const machineId = binding?.machineId ?? session?.metadata?.machineId ?? '';
    const transportSession = React.useRef(sessionId);
    transportSession.current = sessionId;
    const machine = useMachine(machineId);
    const versions = React.useMemo(() => new VersionController(root, (method, input) => artifactRequest(machineId, method, input), accountRuntimeCurrent, loadWorkspaceVersionOperations(scope), value => saveWorkspaceVersionOperations(scope, value)), [root, machineId, scope]);
    const versionSnapshot = React.useSyncExternalStore(versions.subscribe, versions.getSnapshot, versions.getSnapshot);
    const initial = React.useMemo(() => loadFileWorkspaceUI(scope), [scope]);
    const drafts = React.useRef(loadFileWorkspaceDrafts(scope));
    const controller = React.useMemo(() => new FileWorkspaceController({ root,
        read: async (path, signal) => {
            const content = await (binding ? binding.readText(path, signal) : readWorkspaceText(transportSession.current, path));
            if (!binding?.readOnly && machineId && /\.(md|markdown|html?)$/i.test(path)) {
                void versions.current(path).catch(() => {});
            }
            return content;
        },
        write: (path, content, hash) => {
            if (binding?.readOnly) throw new Error(t('projectGoals.readOnlyArchive'));
            if (versions.state(path).pending) throw new Error(t('fileWorkspace.historyPending'));
            return versions.state(path).artifact ? versions.save(path, content, hash) : binding ? binding.writeText(path, content, hash) : writeWorkspaceText(transportSession.current, path, content, hash);
        }, isCurrent: accountRuntimeCurrent,
    }), [binding, root, versions, machineId]);
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const eventRefresh = React.useMemo(() => new EventRefreshQueue(async path => {
        await controller.refresh(path);
        if (versions.state(path).artifact) await versions.load(path, false, false);
    }), [controller, versions, binding?.readOnly]);
    const [draftCacheError, setDraftCacheError] = React.useState(false);
    const [referenceCacheError, setReferenceCacheError] = React.useState(false);
    const [reference, setReference] = React.useState<FileReference | null>(() => {
        const saved = loadFileWorkspaceReference(scope);
        const resolved = saved && resolveSessionFilePath(saved.path, root);
        return saved && resolved?.withinSessionRoot ? { ...saved, path: resolved.absolutePath } : null;
    });
    const [chatWidth, updateChatWidth] = React.useState(initial.width);
    const [chatWidthCustomized, setChatWidthCustomized] = React.useState(initial.widthCustomized ?? false);
    const setChatWidth = React.useCallback((width: number) => { updateChatWidth(width); setChatWidthCustomized(true); }, []);
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
        // A cached Task can render before machine keys finish hydrating.
        // Machine metadata is published only after its encryption is initialized.
        if (!enabled || !root || socketStatus !== 'connected' || (binding && !binding.readOnly && !machine) || restored.current) return;
        restored.current = true;
        // Restore only previously opened tabs, bounded to twenty by persistence.
        const reads = initial.tabs.map(path => { const draft = drafts.current[path]; return controller.open(path).then(() => { if (draft) controller.restoreDraft(path, draft); }); });
        void Promise.allSettled(reads).then(() => { setRestoring(false); restoration.finish(); });
        if (initial.active) void controller.open(initial.active);
        if (!initial.open) controller.setOpen(false);
    }, [controller, enabled, initial, root, socketStatus, restoration, binding, !!machine]);
    const lifetime = React.useRef<object | null>(null);
    React.useEffect(() => {
        const token = {}; lifetime.current = token;
        return () => { queueMicrotask(() => { if (lifetime.current === token) {lifetime.current = null; eventRefresh.dispose(); controller.dispose(); versions.dispose(); restoration.finish();} }); };
    }, [controller, versions, eventRefresh, restoration]);
    React.useEffect(() => {
        if (restored.current && !restoring && accountRuntimeCurrent()) saveFileWorkspaceUI(scope, { tabs: snapshot.tabs, active: snapshot.active, open: snapshot.open, width: chatWidth, widthCustomized: chatWidthCustomized });
    }, [scope, restoring, snapshot.tabs, snapshot.active, snapshot.open, chatWidth, chatWidthCustomized]);
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
    const previousTurn = React.useRef({ sessionId, terminal, initialized: !!session?.metadata });
    React.useEffect(() => {
        const previous = previousTurn.current;
        // Entering another conversation establishes its historical baseline.
        // Its metadata may arrive after the route switched; that first snapshot
        // is still history, not a new completion of the current conversation.
        if (previous.sessionId !== sessionId || !previous.initialized) {
            previousTurn.current = { sessionId, terminal, initialized: !!session?.metadata };
            return;
        }
        previousTurn.current = { sessionId, terminal, initialized: true };
        if (!terminal || previous.terminal === terminal) return;
        eventRefresh.enqueue(controller.getSnapshot().tabs);
    }, [controller, sessionId, terminal, !!session?.metadata, eventRefresh]);
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
        if (binding?.readOnly || !doc || doc.saving || (!action && doc.draft !== doc.content)) return false;
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
    }, [controller, versions, binding?.readOnly]);
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
    return <FileWorkspaceContext.Provider value={{ sessionId, readOnly: binding?.readOnly, readBytes: binding?.readBytes, openRequestId, versions, versionSnapshot, restoreVersion, draftCacheError: draftCacheError || referenceCacheError, enabled, root, controller, snapshot, reference, setReference, openReference, chatWidth, chatWidthCustomized, setChatWidth, maximized, setMaximized }}>{children}</FileWorkspaceContext.Provider>;
}
