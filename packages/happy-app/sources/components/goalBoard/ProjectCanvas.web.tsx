import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { GOAL_CANVAS_PACKAGE_EXTENSION, GoalProjectCanvasChangeNoticeSchema, type GoalProjectCanvasChange } from '@slopus/happy-wire';
import { Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getActiveAccountKey } from '@/auth/accountRuntime';
import { PanelTabs } from '@/components/PanelTabs';
import { Typography } from '@/constants/Typography';
import { projectFileHash } from '@/sync/projectFileHash';
import { useMachine } from '@/sync/storage';
import { getCurrentLanguage, t } from '@/text';
import { PROJECT_CANVAS_REVIEW_ACK_TIMEOUT_MS, readProjectCanvasFrameMessage, type ProjectCanvasCommand, type ProjectCanvasSync } from '../../../../paws-dsh-canvas/src/protocol';
import { GoalBoardButton } from './GoalBoardButton';
import type { ProjectCanvasProps } from './ProjectCanvas';
import { ProjectCanvasGeneratedPicker } from './ProjectCanvasGeneratedPicker.web';
import { ProjectCanvasTools } from './ProjectCanvasTools.web';
import { createProjectCanvasPreview } from './projectCanvasPreview.web';
import { projectCanvasClient, projectCanvasImageTypes, type ProjectCanvasAsset, type ProjectCanvasSnapshot } from './projectCanvasClient.web';
import { applyProjectCanvasPreviewReceipt, type ProjectCanvasPreviewReceipt } from './projectCanvasUpdates.web';
import { supportsProjectCanvas } from './projectMachine';

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
const frameReadyTimeoutMs = 60_000;
type CanvasStatus = 'loading' | 'loadError' | 'assetError' | 'saving' | 'importError' | 'layoutError' | 'referencePending' | 'referenceAdded' | 'referenceError'
    | 'packageImportError' | 'packageExportError' | 'packageImported' | 'packageExported';
type ImageQuality = 'preview' | 'original';
type DisplayImage = { blob: Blob; uri: string; quality: ImageQuality; previewVersionId?: string };
type ImageRequest = {
    id: string;
    versionId: string;
    previewVersionId?: string;
    mode: 'preview' | 'generate-preview' | 'original';
    failedPreviewVersion?: string;
};
function previewForAsset(cache: ReadonlyMap<string, DisplayImage>, asset: ProjectCanvasAsset) {
    const image = cache.get(asset.versionId);
    return image && (!asset.preview || image.previewVersionId === asset.preview.versionId) ? image : undefined;
}
function displayForAsset(cache: ReadonlyMap<string, DisplayImage>, asset: ProjectCanvasAsset) {
    const image = cache.get(asset.versionId);
    return image?.quality === 'original' ? image : previewForAsset(cache, asset);
}

export function ProjectCanvas(props: ProjectCanvasProps) {
    const framePath = getProjectCanvasFramePath();
    if (!framePath) return null;
    return <ProjectCanvasPane key={JSON.stringify([getActiveAccountKey(), props.machineId, props.projectPath])} {...props} framePath={framePath} />;
}

function ProjectCanvasPane({ machineId, projectPath, files, fileViewer, showFile, fileMaximized, compactPane,
    onSelectSurface, onReference, generatedResults, readGeneratedResult, review, onReviewMark, framePath }: ProjectCanvasProps & { framePath: string }) {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    const machine = useMachine(machineId);
    const daemonState = machine?.daemonState as { goalProjectRevision?: string; goalProjectCanvasChange?: unknown } | null;
    const invalidation = daemonState?.goalProjectRevision;
    const rawNotice = daemonState?.goalProjectCanvasChange as { token?: unknown; change?: unknown } | undefined;
    const parsedNotice = GoalProjectCanvasChangeNoticeSchema.safeParse(rawNotice?.change);
    const notice = typeof rawNotice?.token === 'string' && rawNotice.token.length > 0 && rawNotice.token.length <= 200 && parsedNotice.success
        ? { token: rawNotice.token, change: parsedNotice.data } : undefined;
    const previewReceipts = supportsProjectCanvas(machine ?? undefined) && machine?.metadata?.projectCanvas?.previewReceipts === true;
    const client = React.useMemo(() => projectCanvasClient(machineId, projectPath, { previewReceipts }), [machineId, projectPath, previewReceipts]);
    const [snapshot, setSnapshot] = React.useState<ProjectCanvasSnapshot>();
    const current = React.useRef<ProjectCanvasSnapshot | undefined>(undefined);
    const [displayImages, setDisplayImages] = React.useState<ReadonlyMap<string, DisplayImage>>(new Map());
    const previewCache = React.useRef(new Map<string, DisplayImage>());
    const originalCache = React.useRef(new Map<string, { file: File; uri: string }>());
    const originalReads = React.useRef(new Map<string, Promise<File>>());
    const imageQueue = React.useRef(new Map<string, ImageRequest>());
    const activeImages = React.useRef(new Set<string>());
    const readingLargeImage = React.useRef(false);
    const failedImages = React.useRef(new Map<string, ImageRequest>());
    const [previewFailures, setPreviewFailures] = React.useState<Array<{ id: string; versionId: string }>>([]);
    const [status, setStatus] = React.useState<CanvasStatus | null>('loading');
    const [frameReady, setFrameReady] = React.useState(false);
    const rendererReady = React.useRef(false);
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
    const reviewContext = React.useRef({ review, onReviewMark });
    reviewContext.current = { review, onReviewMark };
    const reviewPending = React.useRef<{ id: string; scope: string } | null>(null);
    const [rejectedReview, setRejectedReview] = React.useState<{ id: string; scope: string }>();
    const sessionKey = snapshot ? JSON.stringify([getActiveAccountKey(), machineId, snapshot.id]) : null;
    const locale = getCurrentLanguage().startsWith('zh') ? 'zh' : 'en';
    const lastInvalidation = React.useRef(invalidation);
    const lastNotice = React.useRef(notice?.token);
    const pendingRefresh = React.useRef<{ promise: Promise<ProjectCanvasSnapshot>; targetRevision: number; followup: boolean; unknownRevision: boolean } | null>(null);
    const sentScene = React.useRef<{ sessionKey: string; revision: number } | null>(null);
    const activeFilter = categoryFilter == null || snapshot?.categories?.some(category => category.id === categoryFilter)
        ? categoryFilter : undefined;

    const update = React.useCallback((next: ProjectCanvasSnapshot) => {
        if (current.current && next.revision < current.current.revision) return;
        current.current = next;
        setSnapshot(next);
    }, []);

    const refreshCanvas = React.useCallback(function refresh(signal: AbortSignal, requiredRevision?: number): Promise<ProjectCanvasSnapshot> {
        const pending = pendingRefresh.current;
        if (pending) {
            if (requiredRevision === undefined || requiredRevision > pending.targetRevision) {
                pending.followup = true;
                if (requiredRevision === undefined) pending.unknownRevision = true;
                pending.targetRevision = Math.max(pending.targetRevision, requiredRevision ?? 0);
            }
            return pending.promise;
        }
        let record: NonNullable<typeof pendingRefresh.current>;
        const work = Promise.resolve().then(async () => {
            let next: ProjectCanvasSnapshot | undefined;
            let failed = false;
            let failure: unknown;
            try {
                next = await client.get(signal);
                signal.throwIfAborted();
                update(next);
            } catch (error) { failed = true; failure = error; }
            if (pendingRefresh.current !== record) {
                if (failed) throw failure;
                return next!;
            }
            pendingRefresh.current = null;
            // A newer event can arrive after this request captured its snapshot.
            // Coalesce those events into one trailing read; never query again
            // merely because a response is unchanged or a request failed.
            if (!signal.aborted && record.followup && (record.unknownRevision || (current.current?.revision ?? 0) < record.targetRevision)) {
                return refresh(signal, record.targetRevision || undefined);
            }
            if (failed) throw failure;
            return next!;
        });
        record = { promise: work, targetRevision: requiredRevision ?? 0, followup: false, unknownRevision: false };
        pendingRefresh.current = record;
        return work;
    }, [client, update]);

    const acceptPreview = React.useCallback(async (saved: ProjectCanvasSnapshot | ProjectCanvasPreviewReceipt, signal: AbortSignal) => {
        signal.throwIfAborted();
        if ('id' in saved) { update(saved); return; }
        const next = current.current && applyProjectCanvasPreviewReceipt(current.current, saved);
        if (next) update(next);
        else await refreshCanvas(signal, saved.revision);
    }, [refreshCanvas, update]);

    const publishPreviewFailures = React.useCallback(() => {
        setPreviewFailures([...failedImages.current.values()].filter(item => item.mode !== 'original')
            .map(({ id, versionId }) => ({ id, versionId })));
    }, []);

    const refreshDisplayImages = React.useCallback(() => {
        const next = new Map(previewCache.current);
        for (const [versionId, { file, uri }] of originalCache.current) {
            next.set(versionId, { blob: file, uri, quality: 'original' });
        }
        setDisplayImages(next);
    }, []);

    const cachePreview = React.useCallback((asset: ProjectCanvasAsset, blob: Blob, previewVersionId = asset.preview?.versionId) => {
        const latest = current.current?.assets.find(item => item.id === asset.id);
        if (!latest || latest.versionId !== asset.versionId || latest.preview?.versionId !== asset.preview?.versionId) return;
        const previous = previewCache.current.get(asset.versionId);
        if (previous?.previewVersionId === previewVersionId) return;
        if (previous) URL.revokeObjectURL(previous.uri);
        previewCache.current.set(asset.versionId, { blob, uri: URL.createObjectURL(blob), quality: 'preview', previewVersionId });
        refreshDisplayImages();
    }, [refreshDisplayImages]);

    const cacheOriginal = React.useCallback((asset: ProjectCanvasAsset, file: File) => {
        if (!current.current?.assets.some(item => item.id === asset.id && item.versionId === asset.versionId)) return;
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

    const generatePreview = React.useCallback(async (asset: ProjectCanvasAsset, signal: AbortSignal) => {
        const original = await readOriginal(asset, signal);
        const preview = await createProjectCanvasPreview(original, signal);
        const previewVersionId = await projectFileHash(new Uint8Array(await preview.arrayBuffer()));
        signal.throwIfAborted();
        cachePreview(asset, preview, previewVersionId);
        if (imageQueue.current.has(`original:${asset.versionId}`)) cacheOriginal(asset, original);
        const save = pendingMutations.current.then(async () => {
            if (!signal.aborted) await acceptPreview(await client.putPreview(asset, preview, signal), signal);
        });
        pendingMutations.current = save.catch(() => {});
    }, [acceptPreview, cacheOriginal, cachePreview, client, readOriginal]);

    const pumpImages = React.useCallback(function pump(): void {
        const signal = life.current?.signal;
        if (!signal || signal.aborted) return;
        const queue = imageQueue.current;
        const assets = new Map(current.current?.assets.map(asset => [asset.id, asset]));
        const hasNewPreview = (item: ImageRequest) => {
            const preview = assets.get(item.id)?.preview;
            return item.mode === 'generate-preview' && !!preview && preview.versionId !== item.failedPreviewVersion;
        };
        while (activeImages.current.size < concurrentImages && queue.size) {
            const entries = [...queue];
            // Leave room for thumbnails while a legacy asset needs its full original.
            const canReadOriginal = rendererReady.current && !readingLargeImage.current;
            const next = (canReadOriginal ? entries.find(([, item]) => item.mode === 'original') : undefined)
                ?? entries.find(([, item]) => item.mode === 'preview' || hasNewPreview(item))
                ?? (canReadOriginal ? entries[0] : undefined);
            if (!next) break;
            const [key, request] = next;
            queue.delete(key);
            const asset = assets.get(request.id);
            if (!asset || asset.versionId !== request.versionId) continue;
            const mode = hasNewPreview(request) ? 'preview' : request.mode;
            if (mode === 'original' ? originalCache.current.has(asset.versionId) : previewForAsset(previewCache.current, asset)) continue;

            const large = mode !== 'preview';
            if (large) readingLargeImage.current = true;
            activeImages.current.add(key);
            const work = mode === 'preview'
                ? client.readPreview(asset, signal).then(preview => {
                    signal.throwIfAborted();
                    cachePreview(asset, preview);
                }, () => {
                    if (!signal.aborted) queue.set(key, { ...request, mode: 'generate-preview', failedPreviewVersion: asset.preview?.versionId });
                })
                : mode === 'generate-preview' ? generatePreview(asset, signal) : readOriginal(asset, signal).then(file => {
                    signal.throwIfAborted();
                    cacheOriginal(asset, file);
                });
            void work.catch(() => {
                const latest = current.current?.assets.find(item => item.id === asset.id);
                if (!signal.aborted && latest?.versionId === asset.versionId &&
                    (mode === 'original' || latest.preview?.versionId === asset.preview?.versionId)) {
                    failedImages.current.set(key, request);
                    publishPreviewFailures();
                    setStatus(previous => previous === 'saving' || previous === 'referencePending' ? previous : 'assetError');
                }
            }).finally(() => {
                activeImages.current.delete(key);
                if (large) readingLargeImage.current = false;
                const latest = current.current?.assets.find(item => item.id === asset.id);
                if (!signal.aborted && mode !== 'original' && latest?.versionId === asset.versionId &&
                    latest.preview?.versionId !== asset.preview?.versionId) {
                    // The renderer tracks source versions. Finish its existing
                    // slot with the latest thumbnail if the manifest changed
                    // while this preview request was in flight.
                    const nextKey = `preview:${latest.versionId}:${latest.preview?.versionId ?? 'missing'}`;
                    if (!activeImages.current.has(nextKey) && !previewForAsset(previewCache.current, latest)) {
                        queue.set(nextKey, { id: latest.id, versionId: latest.versionId, previewVersionId: latest.preview?.versionId,
                            mode: latest.preview ? 'preview' : 'generate-preview' });
                    }
                }
                pump();
            });
        }
    }, [cacheOriginal, cachePreview, client, generatePreview, publishPreviewFailures, readOriginal]);

    const requestImages = React.useCallback((ids: readonly string[], quality: ImageQuality) => {
        const assets = new Map(current.current?.assets.map(asset => [asset.id, asset]));
        for (const id of ids) {
            const asset = assets.get(id);
            if (!asset) continue;
            if (quality === 'preview' ? previewForAsset(previewCache.current, asset) : originalCache.current.has(asset.versionId)) continue;
            const key = quality === 'preview' ? `preview:${asset.versionId}:${asset.preview?.versionId ?? 'missing'}` : `original:${asset.versionId}`;
            if (activeImages.current.has(key) || failedImages.current.has(key) || imageQueue.current.has(key)) continue;
            const mode = quality === 'preview' && !asset.preview ? 'generate-preview' : quality;
            imageQueue.current.set(key, { id, versionId: asset.versionId, previewVersionId: asset.preview?.versionId, mode });
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
        let changed = false;
        let releasedImage = false;
        const versions = new Set(snapshot?.assets.map(asset => asset.versionId));
        for (const cache of [previewCache.current, originalCache.current]) {
            for (const [versionId, image] of cache) {
                if (versions.has(versionId)) continue;
                URL.revokeObjectURL(image.uri);
                cache.delete(versionId);
                releasedImage = true;
            }
        }
        if (releasedImage) refreshDisplayImages();
        for (const asset of snapshot?.assets ?? []) {
            if (!previewCache.current.has(asset.versionId) || previewForAsset(previewCache.current, asset)) continue;
            const key = `preview:${asset.versionId}:${asset.preview?.versionId ?? 'missing'}`;
            if (!activeImages.current.has(key) && !failedImages.current.has(key)) {
                imageQueue.current.set(key, { id: asset.id, versionId: asset.versionId, previewVersionId: asset.preview?.versionId,
                    mode: asset.preview ? 'preview' : 'generate-preview' });
            }
        }
        for (const [key, request] of failedImages.current) {
            const asset = snapshot?.assets.find(item => item.id === request.id);
            if (!asset || asset.versionId !== request.versionId || asset.preview?.versionId !== request.previewVersionId) {
                failedImages.current.delete(key);
                changed = true;
            }
        }
        if (changed) publishPreviewFailures();
        pumpImages();
    }, [snapshot, pumpImages, publishPreviewFailures, refreshDisplayImages]);

    React.useEffect(() => {
        let active = true;
        const signal = life.current?.signal;
        if (!signal || signal.aborted) return;
        setStatus('loading');
        void refreshCanvas(signal).then(() => {
            if (!active) return;
            setStatus(null);
        }, () => { if (active) setStatus('loadError'); });
        return () => { active = false; };
    }, [refreshCanvas, reload]);

    React.useEffect(() => {
        const globalChanged = lastInvalidation.current !== invalidation;
        const scopedChanged = lastNotice.current !== notice?.token;
        lastInvalidation.current = invalidation;
        // A scoped event received before the first manifest is known must be
        // reconsidered once that canvas identity arrives.
        if (current.current || !notice) lastNotice.current = notice?.token;
        const signal = life.current?.signal;
        if (!signal || signal.aborted) return;
        if (scopedChanged && notice && current.current?.id === notice.change.canvasId) {
            if (notice.change.kind === 'preview') void acceptPreview(notice.change, signal).catch(() => {});
            else if (notice.change.revision !== current.current.revision) void refreshCanvas(signal, notice.change.revision).catch(() => {});
        }
        if (globalChanged && invalidation && invalidation !== notice?.token) void refreshCanvas(signal).catch(() => {});
    }, [acceptPreview, invalidation, notice?.token, refreshCanvas, snapshot?.id]);

    React.useEffect(() => {
        if (frameReady) return;
        const timer = window.setTimeout(() => setFrameError(true), frameReadyTimeoutMs);
        return () => window.clearTimeout(timer);
    }, [frameReady, reload]);

    React.useEffect(() => {
        if (!frameReady || !sessionKey || !snapshot) { sentScene.current = null; return; }
        const assets = snapshot.assets.map(({ preview: _preview, ...asset }) => {
            const display = displayForAsset(displayImages, { ...asset, preview: _preview });
            return display ? { ...asset, uri: display.uri, sourceQuality: display.quality,
                displaySize: display.blob.size, displayMimeType: display.quality === 'preview' ? 'image/jpeg' as const : asset.mimeType }
                : asset;
        });
        const licenseKey = getCanvasLicense();
        const message: ProjectCanvasSync = {
            type: 'paws-project-canvas/sync', sessionKey, assets, theme: theme.dark ? 'dark' : 'light', locale,
            manifestRevision: snapshot.revision,
            ...(snapshot.scene && (sentScene.current?.sessionKey !== sessionKey || sentScene.current.revision !== snapshot.scene.revision)
                ? { scene: snapshot.scene } : {}),
            previewRequestFailures: previewFailures,
            ...(activeFilter === undefined ? {} : {
                visibleAssetIds: snapshot.assets.filter(asset => (asset.categoryId ?? null) === activeFilter).map(asset => asset.id),
            }),
            ...(review ? { review: {
                scope: review.scope,
                nextNumber: review.nextNumber,
                capacity: review.capacity,
                marks: review.marks.filter(item => item.canvasId === snapshot.id).map(item => item.mark),
                ...(rejectedReview?.scope === review.scope ? { rejectedId: rejectedReview.id } : {}),
            } } : {}),
            palette: { background: colors.groupped.background, surface: colors.surface, text: colors.text,
                divider: colors.divider, accent: colors.textLink, surfaceSelected: colors.surfaceSelected },
            ...(licenseKey ? { licenseKey } : {}),
        };
        frame.current?.contentWindow?.postMessage(message, window.location.origin);
        if (message.scene) sentScene.current = { sessionKey, revision: message.scene.revision };
    }, [activeFilter, frameReady, sessionKey, snapshot, displayImages, previewFailures, theme.dark, colors, locale, review, rejectedReview]);

    React.useEffect(() => {
        function receive(event: MessageEvent<unknown>) {
            if (event.origin !== window.location.origin || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
            const message = readProjectCanvasFrameMessage(event.data);
            if (!message) return;
            if (message.type === 'paws-project-canvas/ready') {
                rendererReady.current = true;
                setFrameReady(true);
                setFrameError(false);
                pumpImages();
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
            if (message.type === 'paws-project-canvas/review-mark') {
                const { review, onReviewMark } = reviewContext.current;
                if (!review || !onReviewMark || message.reviewScope !== review.scope) return;
                const attempt = { scope: review.scope, id: message.mark.id };
                const snapshot = current.current;
                const remaining = message.expiresAt - Date.now();
                const assets = message.mark.ids.flatMap(id => {
                    const asset = snapshot.assets.find(item => item.id === id);
                    return asset ? [{ id, name: asset.name, versionId: asset.versionId }] : [];
                });
                if (reviewPending.current?.scope === review.scope || !review.capacity
                    || message.mark.number !== review.nextNumber || assets.length !== message.mark.ids.length
                    || remaining <= 0 || remaining > PROJECT_CANVAS_REVIEW_ACK_TIMEOUT_MS) {
                    setRejectedReview(attempt);
                    return;
                }
                reviewPending.current = attempt;
                const signal = AbortSignal.any([active, AbortSignal.timeout(remaining)]);
                void (async () => {
                    try {
                        const blob = await (await fetch(message.dataUrl, { signal })).blob();
                        signal.throwIfAborted();
                        if (reviewContext.current.review?.scope !== attempt.scope) return;
                        const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
                        const file = new File([blob], `Canvas mark ${message.mark.number}.${extension}`, { type: blob.type });
                        await onReviewMark(file, { canvasId: snapshot.id, mark: message.mark, assets }, signal, message.expiresAt);
                    } catch {
                        if (!active.aborted && reviewContext.current.review?.scope === attempt.scope) setRejectedReview(attempt);
                    } finally {
                        if (reviewPending.current === attempt) reviewPending.current = null;
                    }
                })();
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
    }, [cacheOriginal, client, pumpImages, readOriginal, requestImages, sessionKey, update]);

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
                    update(saved);
                    const versionId = await projectFileHash(new Uint8Array(await file.arrayBuffer()));
                    const asset = saved.assets.find(item => item.versionId === versionId);
                    if (asset && !asset.preview) {
                        try {
                            const preview = await createProjectCanvasPreview(file, active);
                            const previewVersionId = await projectFileHash(new Uint8Array(await preview.arrayBuffer()));
                            cachePreview(asset, preview, previewVersionId);
                            await acceptPreview(await client.putPreview(asset, preview, active), active);
                        } catch {
                            if (active.aborted) return;
                        }
                    }
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
    const feedbackKey = failure ?? (sceneSaving ? 'saving' : status ?? (frameReady ? null : 'loading'));
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
            rendererReady.current = false;
            setFrameReady(false);
            setFrameError(false);
            setReload(value => value + 1);
            for (const [key, request] of failedImages.current) imageQueue.current.set(key, request);
            failedImages.current.clear();
            publishPreviewFailures();
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
                uri: previewForAsset(previewCache.current, asset)?.uri ?? displayForAsset(displayImages, asset)?.uri })) ?? []}
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
