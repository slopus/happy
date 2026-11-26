import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { GOAL_CANVAS_PACKAGE_EXTENSION, type GoalProjectCanvasChange } from '@slopus/happy-wire';
import { Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getActiveAccountKey } from '@/auth/accountRuntime';
import { PanelTabs } from '@/components/PanelTabs';
import { Typography } from '@/constants/Typography';
import { projectFileHash } from '@/sync/projectFileHash';
import { useMachine } from '@/sync/storage';
import { getCurrentLanguage, t } from '@/text';
import { readProjectCanvasFrameMessage, type ProjectCanvasCommand, type ProjectCanvasSync } from '../../../../paws-dsh-canvas/src/protocol';
import { GoalBoardButton } from './GoalBoardButton';
import type { ProjectCanvasProps } from './ProjectCanvas';
import { ProjectCanvasGeneratedPicker } from './ProjectCanvasGeneratedPicker.web';
import { ProjectCanvasTools } from './ProjectCanvasTools.web';
import { createProjectCanvasPreview } from './projectCanvasPreview.web';
import { projectCanvasClient, projectCanvasImageTypes, type ProjectCanvasAsset, type ProjectCanvasSnapshot } from './projectCanvasClient.web';

function getCanvasLicense(): string | undefined {
    const settings = (globalThis as typeof globalThis & {
        __HAPPY_CONFIG__?: { projectCanvasTldrawLicense?: string; projectCanvasTldrawExpiresAt?: number };
    }).__HAPPY_CONFIG__;
    if (settings?.projectCanvasTldrawExpiresAt !== undefined && Date.now() >= settings.projectCanvasTldrawExpiresAt) {
        return undefined;
    }
    return settings?.projectCanvasTldrawLicense;
}

export function getProjectCanvasFramePath(): string | undefined {
    if (typeof document === 'undefined') return;
    const entry = document.querySelector<HTMLMetaElement>('meta[name="paws-project-canvas-entry"]')?.content;
    if (entry) return getCanvasLicense() && /^\/dsh-image-canvas\/[0-9a-f]{40}\/index\.html$/.test(entry) ? entry : undefined;
    if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(window.location.hostname)) return '/dsh-image-canvas/index.html';
}
const concurrentImages = 3;
const retainedOriginals = 6;
type CanvasStatus = 'loading' | 'loadError' | 'assetError' | 'saving' | 'importError' | 'layoutError' | 'referencePending' | 'referenceAdded' | 'referenceError'
    | 'packageImportError' | 'packageExportError' | 'packageImported' | 'packageExported';
type ImageQuality = 'preview' | 'original';
type DisplayImage = { blob: Blob; uri: string; quality: ImageQuality };
type ImageRequest = { id: string; versionId: string; quality: ImageQuality };

export function ProjectCanvas(props: ProjectCanvasProps) {
    const framePath = getProjectCanvasFramePath();
    if (!framePath) return null;
    return <ProjectCanvasPane key={JSON.stringify([getActiveAccountKey(), props.machineId, props.projectPath])} {...props} framePath={framePath} />;
}

function ProjectCanvasPane({ machineId, projectPath, files, fileViewer, showFile, fileMaximized, compactPane,
    onSelectSurface, onReference, generatedResults, readGeneratedResult, framePath }: ProjectCanvasProps & { framePath: string }) {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    const invalidation = (useMachine(machineId)?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    const client = React.useMemo(() => projectCanvasClient(machineId, projectPath), [machineId, projectPath]);
    const [snapshot, setSnapshot] = React.useState<ProjectCanvasSnapshot>();
    const current = React.useRef<ProjectCanvasSnapshot | undefined>(undefined);
    const [displayImages, setDisplayImages] = React.useState<ReadonlyMap<string, DisplayImage>>(new Map());
    const previewCache = React.useRef(new Map<string, DisplayImage>());
    const originalCache = React.useRef(new Map<string, { file: File; uri: string }>());
    const originalReads = React.useRef(new Map<string, Promise<File>>());
    const imageQueue = React.useRef(new Map<string, ImageRequest>());
    const activeImages = React.useRef(new Set<string>());
    const failedImages = React.useRef(new Map<string, ImageRequest>());
    const [status, setStatus] = React.useState<CanvasStatus | null>('loading');
    const [frameReady, setFrameReady] = React.useState(false);
    const [frameError, setFrameError] = React.useState(false);
    const [addedResults, setAddedResults] = React.useState<ReadonlySet<string>>(new Set());
    const [resultPicker, setResultPicker] = React.useState<typeof readGeneratedResult>();
    const [selectedAssetId, setSelectedAssetId] = React.useState<string>();
    const [selectedAssetIds, setSelectedAssetIds] = React.useState<string[]>([]);
    const [categoryFilter, setCategoryFilter] = React.useState<string | null>();
    const [sceneIssue, setSceneIssue] = React.useState<'sceneSaveError' | 'sceneConflict'>();
    const [sceneSaving, setSceneSaving] = React.useState(false);
    const [reload, setReload] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const life = React.useRef<AbortController | null>(null);
    const pendingMutations = React.useRef(Promise.resolve());
    const pendingReferences = React.useRef(Promise.resolve());
    const flushRequests = React.useRef(new Map<string, (saved: boolean) => void>());
    const frame = React.useRef<HTMLIFrameElement>(null);
    const input = React.useRef<HTMLInputElement>(null);
    const packageInput = React.useRef<HTMLInputElement>(null);
    const importFromFrame = React.useRef<(files: File[]) => void>(() => {});
    const reference = React.useRef(onReference);
    reference.current = onReference;
    const sessionKey = snapshot ? JSON.stringify([getActiveAccountKey(), machineId, snapshot.id]) : null;
    const locale = getCurrentLanguage().startsWith('zh') ? 'zh' : 'en';
    const lastInvalidation = React.useRef(invalidation);
    const activeFilter = categoryFilter == null || snapshot?.categories?.some(category => category.id === categoryFilter)
        ? categoryFilter : undefined;

    const update = React.useCallback((next: ProjectCanvasSnapshot) => {
        if (current.current && next.revision < current.current.revision) return;
        current.current = next;
        setSnapshot(next);
    }, []);

    const refreshDisplayImages = React.useCallback(() => {
        const next = new Map(previewCache.current);
        for (const [versionId, { file, uri }] of originalCache.current) {
            next.set(versionId, { blob: file, uri, quality: 'original' });
        }
        setDisplayImages(next);
    }, []);

    const cachePreview = React.useCallback((asset: ProjectCanvasAsset, blob: Blob) => {
        if (previewCache.current.has(asset.versionId)) return;
        previewCache.current.set(asset.versionId, { blob, uri: URL.createObjectURL(blob), quality: 'preview' });
        refreshDisplayImages();
    }, [refreshDisplayImages]);

    const cacheOriginal = React.useCallback((asset: ProjectCanvasAsset, file: File) => {
        const cache = originalCache.current;
        const existing = cache.get(asset.versionId);
        cache.delete(asset.versionId);
        cache.set(asset.versionId, existing ?? { file, uri: URL.createObjectURL(file) });
        if (cache.size > retainedOriginals) {
            const oldest = cache.entries().next().value;
            if (oldest) {
                cache.delete(oldest[0]);
                URL.revokeObjectURL(oldest[1].uri);
            }
        }
        if (!existing) refreshDisplayImages();
    }, [refreshDisplayImages]);

    const readOriginal = React.useCallback(async (asset: ProjectCanvasAsset, signal: AbortSignal): Promise<File> => {
        signal.throwIfAborted();
        const cached = originalCache.current.get(asset.versionId);
        if (cached) return cached.file;
        const pending = originalReads.current.get(asset.versionId);
        if (pending) return pending;
        const work = client.readAsset(asset, signal);
        originalReads.current.set(asset.versionId, work);
        try {
            return await work;
        } finally {
            if (originalReads.current.get(asset.versionId) === work) originalReads.current.delete(asset.versionId);
        }
    }, [client]);

    const loadPreview = React.useCallback(async (asset: ProjectCanvasAsset, signal: AbortSignal) => {
        if (previewCache.current.has(asset.versionId)) return;
        if (asset.preview) {
            try {
                const preview = await client.readPreview(asset, signal);
                signal.throwIfAborted();
                cachePreview(asset, preview);
                return;
            } catch {
                signal.throwIfAborted();
            }
        }

        // Existing boards acquire a small preview when this particular image is shown.
        const original = await readOriginal(asset, signal);
        const preview = await createProjectCanvasPreview(original, signal);
        signal.throwIfAborted();
        cachePreview(asset, preview);
        const save = pendingMutations.current.then(async () => {
            if (!signal.aborted) update(await client.putPreview(asset, preview, signal));
        });
        pendingMutations.current = save.catch(() => {});
    }, [cachePreview, client, readOriginal, update]);

    const pumpImages = React.useCallback(function pump(): void {
        const signal = life.current?.signal;
        if (!signal || signal.aborted) return;
        const queue = imageQueue.current;
        while (activeImages.current.size < concurrentImages && queue.size) {
            const entries = [...queue];
            const [key, request] = entries.find(([, item]) => item.quality === 'original') ?? entries[0];
            queue.delete(key);
            const asset = current.current?.assets.find(item => item.id === request.id && item.versionId === request.versionId);
            if (!asset) continue;
            activeImages.current.add(key);
            const work = request.quality === 'preview' ? loadPreview(asset, signal) : readOriginal(asset, signal).then(file => {
                signal.throwIfAborted();
                cacheOriginal(asset, file);
            });
            void work.catch(() => {
                if (!signal.aborted) {
                    failedImages.current.set(key, request);
                    setStatus(previous => previous === 'saving' || previous === 'referencePending' ? previous : 'assetError');
                }
            }).finally(() => {
                activeImages.current.delete(key);
                pump();
            });
        }
    }, [cacheOriginal, loadPreview, readOriginal]);

    const requestImages = React.useCallback((ids: readonly string[], quality: ImageQuality) => {
        const assets = new Map(current.current?.assets.map(asset => [asset.id, asset]));
        for (const id of ids) {
            const asset = assets.get(id);
            if (!asset) continue;
            const cache = quality === 'preview' ? previewCache.current : originalCache.current;
            if (cache.has(asset.versionId)) continue;
            const key = `${quality}:${asset.versionId}`;
            if (activeImages.current.has(key) || failedImages.current.has(key)) continue;
            imageQueue.current.set(key, { id, versionId: asset.versionId, quality });
        }
        pumpImages();
    }, [pumpImages]);

    const requestRailPreview = React.useCallback((id: string) => { requestImages([id], 'preview'); }, [requestImages]);

    React.useEffect(() => {
        const controller = new AbortController();
        life.current = controller;
        const previews = previewCache.current;
        const originals = originalCache.current;
        const queue = imageQueue.current;
        const failed = failedImages.current;
        const flushes = flushRequests.current;
        return () => {
            controller.abort();
            for (const image of [...previews.values(), ...originals.values()]) URL.revokeObjectURL(image.uri);
            previews.clear();
            originals.clear();
            queue.clear();
            failed.clear();
            for (const resolve of flushes.values()) resolve(false);
        };
    }, []);

    React.useEffect(() => {
        let active = true;
        setStatus('loading');
        void client.get().then(next => {
            if (!active) return;
            update(next);
            setStatus(null);
        }, () => { if (active) setStatus('loadError'); });
        return () => { active = false; };
    }, [client, reload, update]);

    React.useEffect(() => {
        if (lastInvalidation.current === invalidation) return;
        lastInvalidation.current = invalidation;
        const signal = life.current?.signal;
        if (!signal || signal.aborted) return;
        void client.get(signal).then(update, () => {});
    }, [client, invalidation, update]);

    React.useEffect(() => {
        if (frameReady) return;
        const timer = window.setTimeout(() => setFrameError(true), 18000);
        return () => window.clearTimeout(timer);
    }, [frameReady, reload]);

    React.useEffect(() => {
        if (!frameReady || !sessionKey || !snapshot) return;
        const assets = snapshot.assets.map(({ preview: _preview, ...asset }) => {
            const display = displayImages.get(asset.versionId);
            return display ? { ...asset, uri: display.uri, sourceQuality: display.quality,
                displaySize: display.blob.size, displayMimeType: display.quality === 'preview' ? 'image/jpeg' as const : asset.mimeType }
                : asset;
        });
        const licenseKey = getCanvasLicense();
        const message: ProjectCanvasSync = {
            type: 'paws-project-canvas/sync', sessionKey, assets, theme: theme.dark ? 'dark' : 'light', locale,
            manifestRevision: snapshot.revision,
            ...(snapshot.scene ? { scene: snapshot.scene } : {}),
            ...(activeFilter === undefined ? {} : {
                visibleAssetIds: snapshot.assets.filter(asset => (asset.categoryId ?? null) === activeFilter).map(asset => asset.id),
            }),
            palette: { background: colors.groupped.background, surface: colors.surface, text: colors.text,
                divider: colors.divider, accent: colors.textLink, surfaceSelected: colors.surfaceSelected },
            ...(licenseKey ? { licenseKey } : {}),
        };
        frame.current?.contentWindow?.postMessage(message, window.location.origin);
    }, [activeFilter, frameReady, sessionKey, snapshot, displayImages, theme.dark, colors, locale]);

    React.useEffect(() => {
        function receive(event: MessageEvent<unknown>) {
            if (event.origin !== window.location.origin || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
            const message = readProjectCanvasFrameMessage(event.data);
            if (!message) return;
            if (message.type === 'paws-project-canvas/ready') {
                setFrameReady(true);
                setFrameError(false);
                return;
            }
            if (message.sessionKey !== sessionKey || !current.current) return;
            const active = life.current?.signal;
            if (!active || active.aborted) return;
            if (message.type === 'paws-project-canvas/request-assets') {
                requestImages(message.ids, message.quality);
                return;
            }
            if (message.type === 'paws-project-canvas/selection') {
                setSelectedAssetId(message.ids.length === 1 ? message.ids[0] : undefined);
                setSelectedAssetIds(message.ids);
                return;
            }
            if (message.type === 'paws-project-canvas/scene-flushed') {
                flushRequests.current.get(message.requestId)?.(message.ok);
                return;
            }
            if (message.type === 'paws-project-canvas/scene-error') {
                setSceneIssue(message.reason === 'conflict' ? 'sceneConflict' : 'sceneSaveError');
                return;
            }
            if (message.type === 'paws-project-canvas/import-files') {
                importFromFrame.current(message.files);
                return;
            }
            if (message.type === 'paws-project-canvas/import-failed') {
                setStatus('importError');
                return;
            }
            if (message.type === 'paws-project-canvas/scene') {
                const target = frame.current.contentWindow;
                pendingMutations.current = pendingMutations.current.then(async () => {
                    if (active.aborted || !target) return;
                    setSceneSaving(true);
                    try {
                        const saved = await client.saveScene(message.revision, message.document, message.placements, active);
                        if (!saved.scene) throw new Error('Canvas scene save was not confirmed');
                        update(saved);
                        setSceneIssue(undefined);
                        target.postMessage({ type: 'paws-project-canvas/scene-saved', sessionKey, revision: saved.scene.revision }, window.location.origin);
                    } catch (error) {
                        if (active.aborted) return;
                        const conflict = error instanceof Error && error.message === 'Canvas scene was modified. Reload before saving.';
                        setSceneIssue(conflict ? 'sceneConflict' : 'sceneSaveError');
                        target.postMessage({ type: 'paws-project-canvas/scene-failed', sessionKey, reason: conflict ? 'conflict' : 'save' }, window.location.origin);
                        if (conflict) void client.get(active).then(update, () => {});
                    } finally {
                        if (!active.aborted) setSceneSaving(false);
                    }
                });
                return;
            }
            if (message.type === 'paws-project-canvas/layout') {
                const known = new Set(current.current.assets.map(asset => asset.id));
                if (message.placements.some(placement => !known.has(placement.id))) return;
                pendingMutations.current = pendingMutations.current.then(async () => {
                    if (active.aborted || !current.current) return;
                    setStatus('saving');
                    try {
                        const saved = await client.saveLayout(current.current.revision, message.placements);
                        if (!active.aborted) {
                            update(saved);
                            setStatus(null);
                        }
                    } catch {
                        if (!active.aborted) setStatus('layoutError');
                    }
                });
                return;
            }
            const add = reference.current;
            const assets = message.ids.map(id => current.current?.assets.find(asset => asset.id === id));
            if (!add || assets.some(asset => !asset) || (message.type === 'paws-project-canvas/select' && !assets.length)) return;
            pendingReferences.current = pendingReferences.current.then(async () => {
                if (active.aborted || add !== reference.current) return;
                setStatus('referencePending');
                try {
                    if (message.type === 'paws-project-canvas/select') {
                        for (const asset of assets) {
                            if (!asset || active.aborted || add !== reference.current) return;
                            const original = await readOriginal(asset, active);
                            active.throwIfAborted();
                            cacheOriginal(asset, original);
                            await add(original, asset);
                        }
                    } else {
                        const blob = await (await fetch(message.dataUrl, { signal: active })).blob();
                        const bytes = new Uint8Array(await blob.arrayBuffer());
                        const versionId = await projectFileHash(bytes);
                        active.throwIfAborted();
                        if (add !== reference.current) return;
                        const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
                        const file = new File([bytes], `Canvas selection.${extension}`, { type: blob.type });
                        await add(file, { id: `canvas-selection-${versionId}`, versionId });
                    }
                    if (!active.aborted) setStatus('referenceAdded');
                } catch {
                    if (!active.aborted) setStatus('referenceError');
                }
            });
        }
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [cacheOriginal, client, readOriginal, requestImages, sessionKey, update]);

    function flushScene(): Promise<boolean> {
        const target = frame.current?.contentWindow;
        if (!sessionKey || !frameReady || !target) return Promise.resolve(false);
        const requestId = randomUUID();
        return new Promise(resolve => {
            const finish = (saved: boolean) => {
                window.clearTimeout(timeout);
                flushRequests.current.delete(requestId);
                resolve(saved);
            };
            const timeout = window.setTimeout(() => finish(false), 15_000);
            flushRequests.current.set(requestId, finish);
            target.postMessage({ type: 'paws-project-canvas/command', sessionKey, action: 'flush-scene', requestId }, window.location.origin);
        });
    }

    async function runProjectMutation<T>(operation: (canvas: ProjectCanvasSnapshot, signal: AbortSignal) => Promise<T>): Promise<T> {
        const signal = life.current?.signal;
        if (busy || !signal || signal.aborted || !await flushScene()) throw new Error('Canvas edits must finish saving first');
        const task = pendingMutations.current.then(async () => {
            signal.throwIfAborted();
            if (!current.current) throw new Error('Canvas data is unavailable');
            return operation(current.current, signal);
        });
        pendingMutations.current = task.then(() => {}, () => {});
        return task;
    }

    async function mutateAssets(changes: readonly GoalProjectCanvasChange[]) {
        try {
            await runProjectMutation(async (canvas, signal) => update(await client.mutate(canvas.revision, changes, signal)));
        } catch (error) {
            void client.get(life.current?.signal).then(update, () => {});
            throw error;
        }
    }

    async function transferPackage(action: 'import' | 'export', file?: File, assetIds?: readonly string[]) {
        if (busy) return;
        setBusy(true);
        setStatus('saving');
        try {
            await runProjectMutation(async (canvas, signal) => {
                if (action === 'import' && file) {
                    update(await client.importPackage(file, canvas, signal));
                } else {
                    const blob = await client.exportPackage(canvas, assetIds, signal);
                    const uri = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = uri;
                    link.download = 'project' + GOAL_CANVAS_PACKAGE_EXTENSION;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(uri), 10_000);
                }
            });
            if (!life.current?.signal.aborted) setStatus(action === 'import' ? 'packageImported' : 'packageExported');
        } catch {
            if (!life.current?.signal.aborted) setStatus(action === 'import' ? 'packageImportError' : 'packageExportError');
        } finally {
            if (!life.current?.signal.aborted) setBusy(false);
        }
    }

    function importImages(files: () => Promise<File[]>, resultRef?: string) {
        if (busy || !snapshot) return;
        const active = life.current?.signal;
        if (!active || active.aborted) return;
        setBusy(true);
        pendingMutations.current = pendingMutations.current.then(async () => {
            if (active.aborted) return;
            setStatus('saving');
            try {
                for (const file of await files()) {
                    let saved = await client.importFile(file, active);
                    const versionId = await projectFileHash(new Uint8Array(await file.arrayBuffer()));
                    const asset = saved.assets.find(item => item.versionId === versionId);
                    if (asset && !asset.preview) {
                        try {
                            const preview = await createProjectCanvasPreview(file, active);
                            cachePreview(asset, preview);
                            saved = await client.putPreview(asset, preview, active);
                        } catch {
                            if (active.aborted) return;
                        }
                    }
                    if (!active.aborted) update(saved);
                }
                if (active.aborted) return;
                if (resultRef) setAddedResults(previous => new Set([...previous, resultRef]));
                setStatus(null);
            } catch {
                if (!active.aborted) setStatus('importError');
            } finally {
                if (!active.aborted) setBusy(false);
            }
        });
    }
    importFromFrame.current = files => importImages(async () => files);

    const availableResults = generatedResults?.filter(result => !addedResults.has(result.ref)) ?? [];

    function addResult(ref: string) {
        setResultPicker(undefined);
        const active = life.current?.signal;
        if (!readGeneratedResult || !active || active.aborted || !availableResults.some(result => result.ref === ref)) return;
        importImages(async () => [await readGeneratedResult(ref, active)], ref);
    }

    function chooseResult() {
        if (availableResults.length === 1) addResult(availableResults[0].ref);
        else if (availableResults.length > 1 && readGeneratedResult) setResultPicker(() => readGeneratedResult);
    }

    function viewport(action: 'focus-asset' | 'fit' | 'zoom-in' | 'zoom-out', assetId?: string) {
        if (!sessionKey || !frameReady) return;
        const target = frame.current?.contentWindow;
        if (!target) return;
        const scope = { type: 'paws-project-canvas/command' as const, sessionKey };
        let message: ProjectCanvasCommand;
        if (action === 'focus-asset') {
            const asset = snapshot?.assets.find(asset => asset.id === assetId);
            if (!asset) return;
            requestImages([asset.id], 'original');
            requestImages([asset.id], 'preview');
            setSelectedAssetId(asset.id);
            message = { ...scope, action, assetId: asset.id };
        } else {
            message = { ...scope, action };
        }
        onSelectSurface('canvas');
        target.postMessage(message, window.location.origin);
    }

    const failure = sceneIssue ?? (frameError ? 'loadError' : status?.endsWith('Error') ? status : null);
    const feedbackKey = failure ?? (sceneSaving ? 'saving' : status);
    const feedbackText = feedbackKey ? t(`projectCanvas.${feedbackKey}`) : '';
    const buttonText = { fontSize: 12, color: colors.textLink, ...Typography.default('semiBold') };
    const compactPosition: React.CSSProperties = { position: 'absolute', inset: 0 };
    const showToolbar = !compactPane || !!fileViewer;
    const feedback = <div data-testid="project-canvas-status" role="status"
        style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 8, fontSize: 12, color: failure ? colors.textDestructive : colors.textSecondary }}>
        <span title={feedbackText} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{feedbackText}</span>
        {failure && failure !== 'sceneConflict' && failure !== 'packageImportError' && failure !== 'packageExportError' && <GoalBoardButton variant="toolbar" label={t('projectCanvas.retry')} onPress={() => {
            if (failure === 'sceneSaveError' && sessionKey) {
                frame.current?.contentWindow?.postMessage({ type: 'paws-project-canvas/command', sessionKey, action: 'retry-scene' }, window.location.origin);
                return;
            }
            setSelectedAssetId(undefined);
            setFrameReady(false);
            setFrameError(false);
            setReload(value => value + 1);
            for (const [key, request] of failedImages.current) imageQueue.current.set(key, request);
            failedImages.current.clear();
            pumpImages();
        }}><Text style={buttonText}>{t('projectCanvas.retry')}</Text></GoalBoardButton>}
    </div>;
    return <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, position: 'relative', gap: compactPane || fileMaximized ? 0 : 10 }}>
        <section data-testid="project-canvas" aria-label={t('projectCanvas.title')} style={{
            display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0,
            color: colors.text, background: colors.surface, border: `1px solid ${colors.divider}`, borderRadius: 13, overflow: 'hidden',
            ...(compactPane && { ...compactPosition, visibility: compactPane === 'work' ? 'visible' : 'hidden' }),
        }}>
            {showToolbar && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, minHeight: 47, paddingInline: 12, borderBottom: `1px solid ${colors.divider}` }}>
                {fileViewer ? <PanelTabs testIDPrefix="project-canvas-surface" activeTab={showFile ? 'file' : 'canvas'}
                    onTabChange={key => onSelectSurface(key === 'file' ? 'file' : 'canvas')}
                    tabs={[{ key: 'canvas', label: t('projectCanvas.compactTitle'), icon: 'grid-outline' },
                        { key: 'file', label: t('projectCanvas.fileViewer'), icon: 'document-outline' }]} />
                    : <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 13, ...Typography.header() }}>{t('projectCanvas.compactTitle')}</Text>}
                {!showFile && <div style={{ flexShrink: 1, minWidth: 0, maxWidth: '48%' }}>{feedback}</div>}
            </div>}
            <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
                <div inert={showFile} style={{ ...compactPosition, display: 'flex', visibility: showFile ? 'hidden' : 'inherit', flexDirection: 'column' }}>
                    <iframe ref={frame} key={reload} src={framePath} title={t('projectCanvas.title')} data-testid="dsh-project-canvas-frame"
                        referrerPolicy="no-referrer" style={{ border: 0, flex: 1, minHeight: 0, width: '100%', background: colors.groupped.background }} />
                    {!showToolbar && feedbackKey && <div style={{ padding: '4px 10px', borderTop: `1px solid ${colors.divider}` }}>{feedback}</div>}
                </div>
                {fileViewer && <div inert={!showFile} style={{ ...compactPosition, display: 'flex', visibility: showFile ? 'inherit' : 'hidden' }}>{fileViewer}</div>}
            </div>
        </section>
        <div inert={fileMaximized || (!!compactPane && compactPane !== 'tools')} style={{ display: fileMaximized ? 'none' : 'flex',
            flexDirection: 'column', flex: '0 0 clamp(230px, 23%, 280px)', minWidth: 0, minHeight: 0,
            ...(compactPane && { ...compactPosition, visibility: compactPane === 'tools' ? 'visible' : 'hidden' }) }}>
            <ProjectCanvasTools assets={snapshot?.assets.map(asset => ({ ...asset,
                uri: previewCache.current.get(asset.versionId)?.uri ?? displayImages.get(asset.versionId)?.uri })) ?? []}
                activeAssetId={selectedAssetId} selectedAssetIds={selectedAssetIds} files={files} disabled={!snapshot || busy || !frameReady}
                categories={snapshot?.categories} categoryFilter={activeFilter} onCategoryFilterChange={setCategoryFilter}
                onMutation={mutateAssets} onImportPackage={() => packageInput.current?.click()}
                onExportPackage={ids => transferPackage('export', undefined, ids)}
                previewVisible={!fileMaximized && (!compactPane || compactPane === 'tools')} onPreviewAsset={requestRailPreview}
                canAddResult={!!readGeneratedResult && availableResults.length > 0}
                onImport={() => input.current?.click()} onAddResult={chooseResult}
                onFocusAsset={id => viewport('focus-asset', id)} onFit={() => viewport('fit')}
                onZoom={direction => viewport(direction === 'in' ? 'zoom-in' : 'zoom-out')} />
        </div>
        {resultPicker && resultPicker === readGeneratedResult && availableResults.length > 0 &&
            <ProjectCanvasGeneratedPicker results={availableResults} onSelect={addResult} onClose={() => setResultPicker(undefined)} />}
        <input hidden ref={input} type="file" multiple data-testid="project-canvas-file" accept={projectCanvasImageTypes.join(',')}
            onChange={event => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                if (files.length) importImages(async () => files);
            }} />
        <input hidden ref={packageInput} type="file" data-testid="project-canvas-package-file" accept={GOAL_CANVAS_PACKAGE_EXTENSION}
            onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void transferPackage('import', file);
            }} />
    </div>;
}
