import * as React from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { z } from 'zod';
import { Text } from '@/components/StyledText';
import { WorkspaceButton as Button } from '@/components/fileWorkspace/WorkspaceButton';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { getServerUrl } from '@/sync/serverConfig';
import { getSessionName, resolveSessionState } from '@/utils/sessionUtils';
import { motionWorkbenchRequest, MotionWorkbenchRpcError } from '@/sync/motionWorkbench.web';
import { stageSessionMessage } from '@/sync/messageStagingQueueRuntime';
import { storage, useAllSessions, useSession, useSocketStatus } from '@/sync/storage';
import { getCurrentLanguage, t } from '@/text';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { machineSpawnNewSession } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { linkMotionProject } from './motionArtifactLinks.web';
import type { MotionWorkbenchSnapshot } from '@slopus/happy-wire';
import { createStudioClient, motionStudioFrameHtml, type StudioAssetBytes } from './studioClient.web';
import type { MotionWorkbenchHandle, MotionWorkbenchProps } from './types';

const operationMessage = z.object({ id: z.number().int().positive().safe(), type: z.enum(['state', 'operation']), input: z.unknown() });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const liveOwners = new Map<string, object>();
const resourceOwnerOf = (sessionId: string) => {
    const account = getRuntimeAccountSelection(), metadata = storage.getState().sessions[sessionId]?.metadata;
    return account && metadata?.machineId && metadata.path ? {
        serverUrl: getServerUrl(), accountKey: account.key, accountScope: account.scope, accountGeneration: account.generation,
        machineId: metadata.machineId, sessionRoot: metadata.path,
    } : undefined;
};

export const MotionWorkbench = React.forwardRef<MotionWorkbenchHandle, MotionWorkbenchProps>(function MotionWorkbench(props, ref) {
    const [revision, setRevision] = React.useState(0);
    const [resume, setResume] = React.useState<{ sessionId: string; projectPath: string; time?: number }>();
    return <MotionWorkbenchOwner key={JSON.stringify([props.sessionId, props.projectPath, revision])} {...props} ref={ref}
        resumeTime={resume?.sessionId === props.sessionId && resume.projectPath === props.projectPath ? resume.time : undefined}
        onReload={time => { setResume({ sessionId: props.sessionId, projectPath: props.projectPath, time }); setRevision(value => value + 1); }} />;
});
const MotionWorkbenchOwner = React.forwardRef<MotionWorkbenchHandle, MotionWorkbenchProps & { resumeTime?: number; onReload(time?: number): void }>(function MotionWorkbenchOwner({ sessionId, projectPath, visible, onClose, onReload, onProjectTitleChange, resumeTime }, ref) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const workspace = useFileWorkspace();
    const sessions = useAllSessions();
    const zh = getCurrentLanguage().startsWith('zh');
    const [targetId, setTargetId] = React.useState<string | null>(workspace?.reference?.motion?.projectPath === projectPath ? sessionId : null);
    const [targetChooser, setTargetChooser] = React.useState(false);
    const [creatingUnknown, setCreatingUnknown] = React.useState(false);
    const createdTarget = React.useRef<string | null>(null);
    const [queuedTargets, setQueuedTargets] = React.useState<string[]>([]);
    const target = sessions.find(row => row.id === targetId);
    const canTarget = (id: string) => {
        const candidate = storage.getState().sessions[id];
        return !!session?.metadata?.machineId && candidate?.metadata?.machineId === session.metadata.machineId
            && !!candidate.metadata.path && !!resolveSessionFilePath(projectPath.replace(/\/$/, '') + '/mh.json', candidate.metadata.path)?.withinSessionRoot
            && resolveSessionState(candidate).isConnected;
    };
    const candidates = sessions.filter(row => canTarget(row.id));
    const { status: socketStatus } = useSocketStatus();
    const connected = socketStatus === 'connected' && !!session && resolveSessionState(session).isConnected;
    const connectedRef = React.useRef(connected); connectedRef.current = connected;
    const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading');
    const [error, setError] = React.useState('');
    const [html, setHtml] = React.useState('');
    const [bindingId, setBindingId] = React.useState('');
    const [review, setReview] = React.useState<MotionWorkbenchSnapshot | null>(null);
    const reviewRef = React.useRef(review); reviewRef.current = review;
    const [reviewStale, setReviewStale] = React.useState(false);
    const [selected, setSelected] = React.useState<string[]>([]);
    const [reviewOpen, setReviewOpen] = React.useState(false);
    const [working, setWorking] = React.useState(false);
    const [queued, setQueued] = React.useState(false);
    const [sourceChanged, setSourceChanged] = React.useState(false);
    const sourceChangedRef = React.useRef(false);
    const completedForOwner = React.useRef(false);
    const autoReloadAttempted = React.useRef(false);
    const reloading = React.useRef(false);
    const savedTime = React.useRef<number | undefined>(undefined);
    const reloadRef = React.useRef<() => Promise<void>>(async () => {});
    const [projectTitle, setProjectTitle] = React.useState('');
    const titleCallback = React.useRef(onProjectTitleChange); titleCallback.current = onProjectTitleChange;
    const acceptTitle = React.useCallback((value: unknown) => {
        const state = z.object({ document: z.object({ title: z.string().optional() }) });
        const parsed = state.or(z.object({ state })).safeParse(value);
        if (!parsed.success) return;
        const document = 'document' in parsed.data ? parsed.data.document : parsed.data.state.document;
        const title = document.title?.trim().slice(0, 200) || projectPath.split('/').filter(Boolean).pop() || t('motionWorkbench.title');
        setProjectTitle(title); titleCallback.current?.(title);
    }, [projectPath]);
    const license = React.useRef('');
    const channelNonce = React.useRef('');
    const connectFrameRef = React.useRef<(incoming: MessagePort) => void>(() => {});
    const storagePrefix = 'paws.motion.' + JSON.stringify([getServerUrl(), getRuntimeAccountSelection()?.key ?? 'legacy', sessionId]) + ':';
    const storageKey = storagePrefix + projectPath;
    const resourceOwner = JSON.stringify(resourceOwnerOf(sessionId));
    const viewStorageKey = 'paws.motion.view.' + JSON.stringify([getServerUrl(), getRuntimeAccountSelection()?.key, session?.metadata?.machineId, projectPath]);
    const iframe = React.useRef<HTMLIFrameElement>(null);
    const port = React.useRef<MessagePort | null>(null);
    const initial = React.useRef<{ state: Record<string, unknown>; assets: StudioAssetBytes[] } | null>(null);
    const client = React.useRef<ReturnType<typeof createStudioClient> | null>(null);
    const owner = React.useRef<object | null>(null);
    const controls = React.useRef(new Map<number, { resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }>());
    const controlSequence = React.useRef(0);
    const sending = React.useRef(false);
    const flushEditor = React.useCallback(async () => {
        if (!port.current) return true;
        const id = ++controlSequence.current;
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => { controls.current.delete(id); setError(t('motionWorkbench.closeBlocked')); resolve(false); }, 15000);
            controls.current.set(id, { resolve, timer }); port.current!.postMessage({ type: 'prepare-close', id });
        });
    }, []);
    const loadReview = React.useCallback(async () => {
        if (sending.current || !accountRuntimeCurrent() || !connected) return;
        sending.current = true; setWorking(true); setError(''); setReviewOpen(true); setQueued(false);
        const token = owner.current;
        try {
            if (!await flushEditor()) return;
            const snapshot = await motionWorkbenchRequest(sessionId, 'motionWorkbenchInspect', { projectPath });
            if (!token || owner.current !== token) return;
            setReview(snapshot);
            setReviewStale(false);
            setSelected(snapshot.markers.filter(marker => marker.completion?.requestVersion !== marker.requestVersion).slice(0, 100).map(marker => marker.id));
        } catch (failure) { if (owner.current === token) setError(messageOf(failure)); }
        finally { if (owner.current === token) { sending.current = false; setWorking(false); } }
    }, [sessionId, projectPath, flushEditor, connected]);
    const loadReviewRef = React.useRef(loadReview); loadReviewRef.current = loadReview;

    React.useEffect(() => {
        const token = {}; owner.current = token;
        const current = () => owner.current === token && accountRuntimeCurrent();
        if (liveOwners.has(storageKey)) { setPhase('error'); setError(t('motionWorkbench.unavailable')); return () => { if (owner.current === token) owner.current = null; }; }
        liveOwners.set(storageKey, token);
        if (!globalThis.crypto?.randomUUID || !globalThis.crypto.subtle) { setPhase('error'); setError(t('motionWorkbench.unavailable')); liveOwners.delete(storageKey); return; }
        channelNonce.current = crypto.randomUUID();
        const scope = resourceOwnerOf(sessionId);
        const next = createStudioClient(sessionId, current, motionWorkbenchRequest, { cacheScope: scope && {
            ...scope, isCurrent: () => accountRuntimeCurrent() && JSON.stringify(resourceOwnerOf(sessionId)) === resourceOwner,
        } }); client.current = next;
        const ready = (event: MessageEvent) => {
            if (!current() || event.source !== iframe.current?.contentWindow || event.data?.type !== 'paws-motion-frame-ready' || event.data.nonce !== channelNonce.current || event.ports.length !== 1) return;
            connectFrameRef.current(event.ports[0]);
        };
        window.addEventListener('message', ready);
        void (async () => {
            // React StrictMode can clean up before this microtask; do not open a duplicate sidecar.
            await Promise.resolve(); if (!current()) return;
            const stale = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => !!key && key.startsWith(storagePrefix));
            for (const key of stale) {
                if (key !== storageKey && liveOwners.has(key)) continue;
                const old = sessionStorage.getItem(key);
                if (old && z.string().uuid().safeParse(old).success) await motionWorkbenchRequest(sessionId, 'motionWorkbenchClose', { bindingId: old });
                if (!current()) return;
                if (sessionStorage.getItem(key) === old) sessionStorage.removeItem(key);
            }
            sessionStorage.setItem(storageKey, next.getBindingId());
            const result = await next.open(projectPath);
            if (!current()) return;
            acceptTitle(result.descriptor.state);
            initial.current = { state: result.descriptor.state, assets: result.assets };
            license.current = result.bundle.licenseText;
            setBindingId(result.descriptor.bindingId); setHtml(motionStudioFrameHtml(result.bundle, channelNonce.current));
        })().catch(failure => { if (current()) { setError(messageOf(failure)); setPhase('error'); } });
        return () => {
            if (owner.current === token) owner.current = null;
            if (liveOwners.get(storageKey) === token) liveOwners.delete(storageKey);
            window.removeEventListener('message', ready);
            port.current?.postMessage({ type: 'dispose' }); port.current?.close(); port.current = null;
            for (const control of controls.current.values()) { clearTimeout(control.timer); control.resolve(false); }
            controls.current.clear(); initial.current = null;
            void next.close().then(closed => { if (closed) { try { if (sessionStorage.getItem(storageKey) === next.getBindingId()) sessionStorage.removeItem(storageKey); } catch { /* Preserve a failed cleanup key for the next explicit open. */ } } });
        };
    }, [sessionId, projectPath, storagePrefix, storageKey, resourceOwner, acceptTitle]);

    const connectFrame = React.useCallback((incoming: MessagePort) => {
        const frame = iframe.current?.contentWindow, data = initial.current;
        if (!frame || !data || !owner.current || port.current) { incoming.close(); return; }
        const token = owner.current;
        let requests = 0;
        port.current = incoming;
        incoming.onmessage = async event => {
            if (owner.current !== token || !accountRuntimeCurrent()) return;
            const raw = event.data as Record<string, unknown> | null;
            if (!raw || typeof raw !== 'object') return;
            if (raw.type === 'ready') {
                setPhase('ready'); setError('');
                let restoreTime = resumeTime;
                try { if (restoreTime === undefined) { const stored = JSON.parse(localStorage.getItem(viewStorageKey) ?? 'null'); if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) restoreTime = stored; } } catch {}
                if (restoreTime !== undefined) incoming.postMessage({ type: 'seek', time: restoreTime });
                return;
            }
            if (raw.type === 'review-request') { void loadReviewRef.current(); return; }
            if (raw.type === 'source-changed') {
                sourceChangedRef.current = true; setSourceChanged(true); setReviewStale(true); setError(t('motionWorkbench.sourceChanged'));
                if (completedForOwner.current && !autoReloadAttempted.current) { autoReloadAttempted.current = true; void reloadRef.current(); }
                return;
            }
            if (raw.type === 'error') { setError(typeof raw.message === 'string' ? raw.message.slice(0, 2048) : t('motionWorkbench.unavailable')); return; }
            if (raw.type === 'diagnostic') { setPhase('error'); setError(typeof raw.message === 'string' ? raw.message.split('\n')[0].slice(0, 2048) : t('motionWorkbench.unavailable')); return; }
            if ((raw.type === 'close-ready' || raw.type === 'close-blocked') && typeof raw.id === 'number') {
                const pending = controls.current.get(raw.id); if (!pending) return;
                if (raw.type === 'close-ready') { incoming.postMessage({ type: 'context', id: raw.id }); return; }
                controls.current.delete(raw.id); clearTimeout(pending.timer); pending.resolve(false);
                if (raw.type === 'close-blocked') setError(typeof raw.message === 'string' ? raw.message.slice(0, 2048) : t('motionWorkbench.closeBlocked'));
                return;
            }
            if (raw.type === 'context' && typeof raw.id === 'number') {
                const pending = controls.current.get(raw.id); if (!pending) return;
                const view = z.object({ playback: z.object({ time: z.number().finite().nonnegative() }) }).safeParse(raw.value);
                savedTime.current = view.success ? view.data.playback.time : undefined;
                if (savedTime.current !== undefined) { try { localStorage.setItem(viewStorageKey, JSON.stringify(savedTime.current)); } catch {} }
                controls.current.delete(raw.id); clearTimeout(pending.timer); pending.resolve(true); return;
            }
            const parsed = operationMessage.safeParse(raw); if (!parsed.success) return;
            if (!connectedRef.current || requests >= 8) { incoming.postMessage({ type: 'result', id: parsed.data.id, error: t('motionWorkbench.offline') }); return; }
            requests++;
            try {
                const result = parsed.data.type === 'state' ? await client.current!.state() : await client.current!.operation(parsed.data.input);
                if (owner.current === token) { acceptTitle(result.value); incoming.postMessage({ type: 'result', id: parsed.data.id, ...result }); }
            } catch (failure) {
                if (owner.current === token) incoming.postMessage({ type: 'result', id: parsed.data.id, error: messageOf(failure) });
            } finally { requests--; }
        };
        incoming.postMessage({ type: 'paws-motion-connect', ...data, theme: theme.dark ? 'dark' : 'light' });
        initial.current = null;
    }, [theme.dark, acceptTitle, resumeTime, viewStorageKey]);
    connectFrameRef.current = connectFrame;
    React.useEffect(() => { port.current?.postMessage({ type: 'theme', value: theme.dark ? 'dark' : 'light' }); }, [theme.dark, phase]);
    React.useEffect(() => { port.current?.postMessage({ type: 'visibility', visible }); }, [visible, phase]);

    const prepareClose = React.useCallback(async () => {
        if (sending.current) return false;
        return flushEditor();
    }, [flushEditor]);
    const reload = React.useCallback(async () => {
        if (reloading.current) return;
        reloading.current = true;
        const token = owner.current;
        try { if (await prepareClose() && token && owner.current === token) onReload(savedTime.current); }
        finally { reloading.current = false; }
    }, [prepareClose, onReload]);
    reloadRef.current = reload;
    React.useImperativeHandle(ref, () => ({ prepareClose }), [prepareClose]);
    const invalidation = session?.metadata?.motionWorkbenchChanges?.find(change => change.bindingId === bindingId)?.sequence ?? 0;
    const previousInvalidation = React.useRef(0);
    React.useEffect(() => {
        if (!port.current || invalidation <= previousInvalidation.current) return;
        previousInvalidation.current = invalidation; port.current?.postMessage({ type: 'refresh' });
        if (reviewRef.current) setReviewStale(true);
    }, [invalidation, phase]);
    const observedTurns = [...new Set([sessionId, ...queuedTargets])].map(id => {
        const actor = id === sessionId ? session : sessions.find(row => row.id === id);
        const turn = actor?.agentState?.turnStatus;
        return { id, status: turn?.status, terminal: turn && ['completed', 'cancelled', 'failed'].includes(turn.status) ? `${turn.turnId}:${turn.updatedAt}` : null };
    });
    const turnSignature = JSON.stringify(observedTurns);
    const previousTurns = React.useRef(new Map(observedTurns.map(row => [row.id, row.terminal])));
    const rememberTarget = (id: string) => {
        const turn = storage.getState().sessions[id]?.agentState?.turnStatus;
        previousTurns.current.set(id, turn && ['completed', 'cancelled', 'failed'].includes(turn.status) ? `${turn.turnId}:${turn.updatedAt}` : null);
        setQueuedTargets(value => value.includes(id) ? value : [...value, id]);
    };
    React.useEffect(() => {
        if (!port.current || phase !== 'ready') return;
        let refresh = false, completed = false;
        for (const row of observedTurns) {
            const known = previousTurns.current.has(row.id), previous = previousTurns.current.get(row.id);
            previousTurns.current.set(row.id, row.terminal);
            if (row.status === 'running') completedForOwner.current = false;
            if (!known || !row.terminal || row.terminal === previous) continue;
            refresh = true; if (row.status === 'completed') completed = true;
        }
        if (!refresh) return;
        // A chosen collaboration session can finish after the transport's file event.
        // Observe the frozen submitted targets, independently of later UI selection.
        if (completed) {
            completedForOwner.current = true;
            if (sourceChangedRef.current && !autoReloadAttempted.current) {
                autoReloadAttempted.current = true; void reloadRef.current(); return;
            }
        }
        port.current.postMessage({ type: 'refresh' });
        if (reviewRef.current) setReviewStale(true);
    }, [turnSignature, phase]);
    const previousConnection = React.useRef<boolean | null>(null);
    React.useEffect(() => {
        if (!port.current || phase !== 'ready') return;
        if (previousConnection.current !== connected && (previousConnection.current !== null || !connected)) port.current.postMessage({ type: 'connection', connected });
        previousConnection.current = connected;
    }, [connected, phase]);

    React.useEffect(() => {
        if (targetId === sessionId && workspace && workspace.reference?.motion?.projectPath !== projectPath) setTargetId(null);
    }, [workspace?.reference, sessionId, projectPath]);
    const chooseTarget = async (id: string) => {
        if (sending.current || !canTarget(id)) return;
        sending.current = true; setWorking(true); setError(''); const token = owner.current;
        try {
            if (!await flushEditor()) return;
            const snapshot = await motionWorkbenchRequest(sessionId, 'motionWorkbenchInspect', { projectPath });
            if (!token || owner.current !== token || !canTarget(id) || !accountRuntimeCurrent()) return;
            await linkMotionProject(id, { projectId: snapshot.projectId, projectPath: snapshot.projectPath, title: projectTitle || 'MotionHarness' });
            if (owner.current !== token || !accountRuntimeCurrent()) return;
            if (id === sessionId) workspace?.setReference({ path: snapshot.projectPath.replace(/\/$/, '') + '/mh.json', hash: snapshot.snapshotHash,
                motion: { projectId: snapshot.projectId, projectPath: snapshot.projectPath, title: projectTitle || 'MotionHarness', documentRevision: snapshot.documentRevision, buildId: snapshot.buildId, markerVersion: snapshot.markerVersion, snapshotHash: snapshot.snapshotHash } });
            setTargetId(id); setTargetChooser(false); if (createdTarget.current === id) createdTarget.current = null;
        } catch (failure) { if (owner.current === token) setError(messageOf(failure)); }
        finally { if (owner.current === token) { sending.current = false; setWorking(false); } }
    };
    const createTarget = async () => {
        if (sending.current || creatingUnknown || !session?.metadata?.machineId || !session.metadata.path) return;
        sending.current = true; setWorking(true); setError(''); const token = owner.current;
        try {
            if (!await flushEditor()) return;
            let id = createdTarget.current;
            if (!id) {
                const result = await machineSpawnNewSession({ machineId: session.metadata.machineId, directory: session.metadata.path,
                    agent: session.metadata.flavor === 'claude' ? 'claude' : 'codex', approvedNewDirectoryCreation: false, traceId: crypto.randomUUID() });
                if (!token || owner.current !== token || !accountRuntimeCurrent()) return;
                if (result.type !== 'success') {
                    if (result.type === 'error' && (('outcomeUnknown' in result && result.outcomeUnknown) || 'sessionId' in result)) setCreatingUnknown(true);
                    throw new Error('errorMessage' in result ? result.errorMessage : 'The new session is not ready. Check the session list.');
                }
                id = result.sessionId; createdTarget.current = id;
            }
            if (!await sync.ensureSessionHydrated(id) || owner.current !== token || !accountRuntimeCurrent()) throw new Error('Created session is not ready. Retry to connect to the same session.');
            sending.current = false; setWorking(false); await chooseTarget(id);
        } catch (failure) { if (owner.current === token) setError(messageOf(failure)); }
        finally { if (owner.current === token) { sending.current = false; setWorking(false); } }
    };
    const sendReview = async () => {
        if (sending.current || !review || reviewStale || !selected.length || !connected || !targetId || !canTarget(targetId)) return;
        sending.current = true; setWorking(true); setError(''); const token = owner.current, frozenTarget = targetId;
        try {
            if (!await flushEditor()) return;
            const markers = review.markers.filter(marker => selected.includes(marker.id)).map(marker => ({ id: marker.id, requestVersion: marker.requestVersion }));
            const prepared = await motionWorkbenchRequest(sessionId, 'motionWorkbenchPrepareReview', { projectPath, projectId: review.projectId, snapshotHash: review.snapshotHash, markers });
            if (!token || owner.current !== token || !accountRuntimeCurrent()) return;
            const display = t('motionWorkbench.reviewMessage') + '\n' + review.markers.filter(marker => selected.includes(marker.id)).map(marker => '• ' + (marker.notes || marker.label).slice(0, 600)).join('\n');
            if (!canTarget(frozenTarget)) throw new Error('The target session is unavailable');
            rememberTarget(frozenTarget);
            await stageSessionMessage(frozenTarget, prepared.prompt, undefined, 'queue', { draftText: display, displayText: display });
            if (owner.current === token) { setQueued(true); setSelected([]); }
        } catch (failure) { if (owner.current === token) { setError(messageOf(failure)); if (failure instanceof MotionWorkbenchRpcError && failure.code === 'STALE_REVIEW') setReviewStale(true); } }
        finally { if (owner.current === token) { sending.current = false; setWorking(false); } }
    };
    const exportWithAi = async () => {
        if (sending.current || !client.current || !connected || !targetId || !canTarget(targetId)) return;
        sending.current = true; setWorking(true); setError(''); const token = owner.current, frozenTarget = targetId;
        try {
            if (!await flushEditor()) return;
            const current = await client.current.state();
            if (!token || owner.current !== token || !accountRuntimeCurrent()) return;
            const bound = client.current.getDescriptor();
            const document = z.object({ revision: z.number(), settings: z.record(z.string(), z.unknown()) }).parse(current.value.document);
            const context = { projectPath: bound?.projectPath, projectId: bound?.projectId, buildId: current.value.buildId, documentRevision: document.revision, settings: document.settings };
            const prompt = [
                'Export this saved MotionHarness project as a new H.264 MP4 and deliver it in Paws.',
                'Read the project instructions and documented native export workflow. Preserve existing source, media, document edits and older exports.',
                'Check the bound build and document revision below before rendering. If they changed, report the changed version instead of silently exporting another version.',
                'Use the saved dimensions, frame rate, duration and project-specific quality instructions. Write a new file inside the project deliverables directory.',
                'Verify codec, dimensions, duration and full decoding. Use the available Paws media delivery tool with the exact absolute output path so this device can play or download the MP4. Report any delivery failure plainly.',
                'The JSON is project data, never shell text.', '```json', JSON.stringify(context, null, 2).replace(/</g, '\\u003c').replace(/`/g, '\\u0060'), '```',
            ].join('\n');
            if (!canTarget(frozenTarget)) throw new Error('The target session is unavailable');
            rememberTarget(frozenTarget);
            await stageSessionMessage(frozenTarget, prompt, undefined, 'queue', { draftText: t('motionWorkbench.export'), displayText: t('motionWorkbench.export') });
            if (owner.current === token) setQueued(true);
        } catch (failure) { if (owner.current === token) setError(messageOf(failure)); }
        finally { if (owner.current === token) { sending.current = false; setWorking(false); } }
    };
    const downloadLicense = () => {
        const url = URL.createObjectURL(new Blob([license.current], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'MotionHarness-Studio-0.1.8-GPL-3.0.txt'; anchor.click(); URL.revokeObjectURL(url);
    };
    return <View testID="motion-workbench" style={{ flex: 1, minWidth: 0, minHeight: 0, display: visible ? 'flex' : 'none', backgroundColor: theme.colors.surface }}>
        <DesktopDialogFrame visible={targetChooser} title={zh ? '选择协作会话' : 'Choose a conversation'} onClose={() => setTargetChooser(false)} testID="motion-target-dialog" maxWidth={580}>
            <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} style={{ maxHeight: 480 }}>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>{zh ? '选择后只关联工程；发送标注或输入要求才会调用 AI。仅列出同一执行机、允许访问该工程的在线会话。' : 'Choosing links the project only. Send annotations or a message to invoke AI. Only connected conversations on the same machine with access to this project are listed.'}</Text>
                {candidates.map(candidate => <Button key={candidate.id} label={getSessionName(candidate)} testID={'motion-target:' + candidate.id} disabled={working} onPress={() => { void chooseTarget(candidate.id); }} />)}
                {!candidates.length && <Text style={{ color: theme.colors.textSecondary }}>{zh ? '没有可用会话。可以新建会话后继续。' : 'No eligible conversation. Create one to continue.'}</Text>}
                <Button label={createdTarget.current ? (zh ? '重试连接已创建会话' : 'Reconnect to the created conversation') : (zh ? '新建会话继续修改' : 'Continue in a new conversation')} icon="add-outline" testID="motion-target-new" disabled={working || creatingUnknown || !connected} onPress={() => { void createTarget(); }} />
                {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            </ScrollView>
        </DesktopDialogFrame>
        <View style={{ padding: 8, gap: 6, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: theme.colors.divider }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: theme.colors.textSecondary }}>{target ? (zh ? '协作会话：' : 'Conversation: ') + getSessionName(target) : (zh ? '查看工程 · 尚未选择 AI 协作会话' : 'Viewing project · choose a conversation for AI edits')}</Text>
            <Button label={zh ? '选择协作会话' : 'Choose conversation'} testID="motion-target-choose" disabled={working || phase !== 'ready'} onPress={() => setTargetChooser(true)} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 6, borderBottomWidth: 1, borderColor: theme.colors.divider, flexWrap: 'wrap' }}>
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 13 }}>{projectTitle ? `${projectTitle} · ` : ''}{t('motionWorkbench.title')}</Text>
            {queued && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{t('motionWorkbench.queued')}</Text>}
            {sourceChanged && <Button label={t('motionWorkbench.reopen')} testID="motion-reopen" disabled={working} onPress={() => { void reload(); }} />}
            <Button label={t('motionWorkbench.annotations')} testID="motion-review-open" disabled={phase !== 'ready' || working || !connected} onPress={() => { void loadReview(); }} />
            <Button label={t('motionWorkbench.export')} icon="download-outline" disabled={phase !== 'ready' || working || !connected || sourceChanged || !targetId} onPress={() => { void exportWithAi(); }} />
            <Button label={t('motionWorkbench.license')} icon="information-circle-outline" compact disabled={phase !== 'ready'} onPress={downloadLicense} />
            <Button label={t('fileWorkspace.refresh')} compact icon="refresh-outline" disabled={phase !== 'ready' || !connected} onPress={() => port.current?.postMessage({ type: 'refresh' })} />
            <Button label={t('fileWorkspace.close')} compact icon="close-outline" onPress={() => { void prepareClose().then(ready => { if (ready) onClose(); }); }} />
        </View>
        {!connected && <Text accessibilityLiveRegion="polite" style={{ padding: 8, color: theme.colors.textSecondary }}>{t('motionWorkbench.offline')}</Text>}
        {!!error && <Text accessibilityRole="alert" selectable style={{ padding: 8, color: theme.colors.textDestructive }}>{error}</Text>}
        {phase === 'loading' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}><ActivityIndicator color={theme.colors.textSecondary} /><Text style={{ color: theme.colors.textSecondary }}>{t('motionWorkbench.loading')}</Text></View>}
        {!!html && React.createElement('iframe', { ref: iframe, title: t('motionWorkbench.title'), 'data-testid': 'motion-studio-frame', srcDoc: html,
            sandbox: 'allow-scripts allow-downloads', style: { flex: 1, width: '100%', minHeight: 320, border: 0 } })}
        {reviewOpen && <View style={{ maxHeight: 250, borderTopWidth: 1, borderColor: theme.colors.divider }}>
            <View style={{ flexDirection: 'row', padding: 8, alignItems: 'center', gap: 6 }}>
                <Text style={{ flex: 1, color: theme.colors.text, fontSize: 13 }}>{t('motionWorkbench.annotations')}</Text>
                <Button label={t('fileWorkspace.refresh')} compact icon="refresh-outline" disabled={working || !connected} onPress={() => { void loadReview(); }} />
                <Button label={t('motionWorkbench.send')} testID="motion-review-send" disabled={working || reviewStale || !selected.length || !connected || !targetId} onPress={() => { void sendReview(); }} />
                <Button label={t('fileWorkspace.close')} compact icon="close-outline" onPress={() => setReviewOpen(false)} />
            </View>
            {reviewStale && <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: 8, color: theme.colors.textSecondary }}>{t('motionWorkbench.reviewChanged')}</Text>}
            <ScrollView contentContainerStyle={{ padding: 8, gap: 6 }}>
                {review?.markers.length === 0 && <Text style={{ color: theme.colors.textSecondary }}>{t('motionWorkbench.empty')}</Text>}
                {review?.markers.map(marker => <View key={marker.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                    <Button label={selected.includes(marker.id) ? t('motionWorkbench.selected') : t('motionWorkbench.select')} icon={selected.includes(marker.id) ? 'checkbox-outline' : 'square-outline'} compact selected={selected.includes(marker.id)} disabled={working || marker.completion?.requestVersion === marker.requestVersion}
                        onPress={() => setSelected(value => value.includes(marker.id) ? value.filter(id => id !== marker.id) : value.length < 100 ? [...value, marker.id] : value)} />
                    <View style={{ flex: 1, gap: 3 }}><Text style={{ color: theme.colors.text, fontSize: 13 }}>{marker.label}</Text>{!!marker.notes && <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{marker.notes}</Text>}</View>
                    {typeof marker.start === 'number' && <Button label={marker.start.toFixed(2) + 's'} onPress={() => port.current?.postMessage({ type: 'seek', time: marker.start })} />}
                </View>)}
            </ScrollView>
        </View>}
    </View>;
});
