import { atom, createShapeId, loadSnapshot, type BoxLike, type Editor, type TLAssetId, type TLImageAsset, type TLImageShape,
    type TLShape, type TLShapeId, type TLShapePartial } from 'tldraw';
import { blobToDataUrl } from '../../vendor/dsh-image-gen/src/client/browser-image-utils';
import { landTlItems } from '../../vendor/dsh-image-gen/src/client/tl/studio-tl-canvas';
import type { TlLandingItem } from '../../vendor/dsh-image-gen/src/client/tl/tl-canvas-bridge';
import { PROJECT_CANVAS_ORIGINAL_REQUEST_MAX, PROJECT_CANVAS_PREVIEW_REQUEST_MAX,
    isCanvasImportBatch, type ProjectCanvasAssetQuality, type ProjectCanvasImageMime, type ProjectCanvasPlacement,
    type ProjectCanvasRenderAsset } from '../protocol';
import { currentSync, postCanvasMessage, subscribeCommand, subscribeSceneResult, subscribeSync } from './bridge';
import { fetchDisplayBlob, removeAssetUri, setAssetUri } from './imageCache';
import { managedAssetKey, readSceneDocument, writeSceneDocument } from './sceneDocument';
import { createSceneSync } from './sceneSync';

const canvasKey = (asset: ProjectCanvasRenderAsset) => `${asset.id}-${asset.versionId}`;
const shapeIdOf = (key: string) => createShapeId(`ig-${key}`);
const imageAssetIdOf = (key: string) => `asset:ig-${key}` as TLAssetId;
const boundCoordinate = (coordinate: number) => Math.max(-1_000_000, Math.min(1_000_000, Math.round(coordinate)));
const visibleAssets = atom<ReadonlySet<string> | undefined>('visible project canvas assets', undefined);

function fitCanvasBounds(editor: Editor, bounds: BoxLike | undefined, maxZoom = Infinity): boolean {
    if (!bounds) return false;
    const { width, height } = editor.getViewportScreenBounds();
    if (width <= 0 || height <= 0) return false;
    // The Studio tool rail and its adjacent selection actions can take nearly
    // 100 CSS pixels. Keep the fit away from both when there is room.
    const left = Math.min(108, width * 0.24);
    const right = Math.min(24, width * 0.08);
    const top = Math.min(60, height * 0.2);
    const bottom = Math.min(46, height * 0.16);
    const availableWidth = width - left - right;
    const availableHeight = height - top - bottom;
    const baseZoom = editor.getBaseZoom();
    const { zoomSteps } = editor.getCameraOptions();
    const zoom = Math.max(zoomSteps[0] * baseZoom, Math.min(
        zoomSteps[zoomSteps.length - 1] * baseZoom, maxZoom,
        availableWidth / Math.max(1, bounds.w), availableHeight / Math.max(1, bounds.h),
    ));
    editor.setCamera({
        x: -bounds.x + (left + (availableWidth - bounds.w * zoom) / 2) / zoom,
        y: -bounds.y + (top + (availableHeight - bounds.h * zoom) / 2) / zoom,
        z: zoom,
    }, { immediate: true });
    return true;
}

function keyOfShape(shape: TLShape): string | undefined {
    return shape.type === 'image' && typeof shape.meta.galleryId === 'string'
        && managedAssetKey.test(shape.meta.galleryId)
        ? shape.meta.galleryId : undefined;
}

function isFiltered(key: string): boolean {
    const visible = visibleAssets.get();
    const id = key.slice(0, -65);
    return visible !== undefined && !visible.has(id);
}

export function projectShapeVisibility(shape: TLShape): 'inherit' | 'hidden' {
    const key = keyOfShape(shape);
    return key && isFiltered(key) ? 'hidden' : 'inherit';
}

export function selectedAssetIds(shapes: readonly TLShape[]): string[] {
    const valid = new Map((currentSync()?.assets ?? []).map(asset => [canvasKey(asset), asset.id]));
    const ids = shapes.flatMap(shape => {
        const key = keyOfShape(shape);
        const id = key && valid.get(key);
        return id ? [id] : [];
    });
    return [...new Set(ids)];
}

interface DisplayImage {
    uri: string;
    dataUrl: string;
    mimeType: ProjectCanvasImageMime;
    quality?: ProjectCanvasAssetQuality;
    width: number;
    height: number;
    length: number;
}

async function readDisplayImage(asset: ProjectCanvasRenderAsset, uri: string): Promise<DisplayImage> {
    const blob = await fetchDisplayBlob(uri);
    const mimeType = asset.displayMimeType ?? asset.mimeType;
    // The SDK persists asset props and limits their URL schemes. Object
    // URLs only transport image bytes between the host and this frame.
    const dataUrl = await blobToDataUrl(blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }));
    const preview = new Image();
    preview.src = dataUrl;
    await preview.decode();
    return {
        uri, dataUrl, mimeType, quality: asset.sourceQuality,
        width: preview.naturalWidth, height: preview.naturalHeight, length: blob.size,
    };
}

function landingOf(asset: ProjectCanvasRenderAsset, source: DisplayImage): TlLandingItem {
    const key = canvasKey(asset);
    return {
        galleryId: key,
        onlyWhileCanvasOpen: true,
        attachment: {
            attachmentId: key as TlLandingItem['attachment']['attachmentId'],
            mediaType: source.mimeType,
            bytes: source.length,
            width: source.width,
            height: source.height,
            name: asset.name,
        },
    };
}

let mountedEditor: Editor | undefined;

export function getCanvasEditor(): Editor | undefined {
    return mountedEditor;
}

export function attachProjectEditor(editor: Editor, sessionKey: string): () => void {
    mountedEditor = editor;
    // Paws already owns the viewport and manifest placement. Reuse the
    // upstream landing operation without its temporary view-to-grid step.
    const landingEditor = new Proxy(editor, {
        get(target, key) {
            if (key === 'centerOnPoint' || key === 'zoomToBounds') return () => target;
            if (key === 'createAssets' || key === 'createShapes') return (records: never) => {
                target.store.mergeRemoteChanges(() => target[key](records));
                return target;
            };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const queued = new Set<string>();
    const loading = new Map<string, string>();
    const displays = new Map<string, DisplayImage>();
    const failedDisplays = new Map<string, string>();
    const requestedPreviews = new Set<string>();
    const pendingPreviews = new Set<string>();
    let failedPreviews = new Set<string>();
    const requestedOriginals = new Set<string>();
    const removed = new Set<string>();
    let desired = new Map<string, ProjectCanvasRenderAsset>();
    let disposed = false;
    let fitFrame: number | undefined;
    let previewFrame: number | undefined;
    let wheelFrame: number | undefined;
    let initialFit = true;
    let requestedAsset: string | undefined;
    let filterKey: string | undefined;
    let sceneRevision: number | undefined;
    const studioTheme = editor.getTheme('default');
    let paletteState = '';

    const scene = createSceneSync({
        sessionKey,
        serialize: () => writeSceneDocument(editor.store, removed),
        restore(document) {
            const restored = readSceneDocument(document, editor.store);
            if (!restored) return false;
            editor.store.mergeRemoteChanges(() => loadSnapshot(editor.store, { document: restored }));
            editor.clearHistory();
            removed.clear();
            for (const key of restored.removed) {
                if (desired.has(key) && !editor.getShape(shapeIdOf(key))) removed.add(key);
            }
            return true;
        },
        placements() {
            const result: ProjectCanvasPlacement[] = [];
            for (const [key, asset] of desired) {
                const shape = editor.getShape(shapeIdOf(key));
                if (!shape) continue;
                const position = shapePosition(shape);
                if (asset.x !== position.x || asset.y !== position.y) result.push({ id: asset.id, ...position });
            }
            return result;
        },
        post: postCanvasMessage,
        failed: reason => postCanvasMessage({ type: 'paws-project-canvas/scene-error', sessionKey, reason }),
    });
    const stopSceneResults = subscribeSceneResult(result => {
        if (!disposed && result.sessionKey === sessionKey) scene.receive(result);
    });
    const beforePointerDown = (): void => { scene.trackPointer(true); };
    const clearPointer = (): void => {
        if (!disposed && currentSync()?.sessionKey === sessionKey && scene.trackPointer(false)) {
            removeOrphans();
            if (!scene.hasLocalEdits()) alignShapes(desired.keys(), 'authoritative');
            fitPlacedImages();
            for (const [key, asset] of desired) void hydrateDisplay(key, asset);
        }
    };
    const afterPointerUp = (): void => { queueMicrotask(clearPointer); };
    const saveDraft = (): void => { scene.saveDraft(); };
    window.addEventListener('pointerdown', beforePointerDown, true);
    window.addEventListener('pointerup', afterPointerUp);
    window.addEventListener('pointercancel', afterPointerUp);
    window.addEventListener('blur', clearPointer);
    window.addEventListener('pagehide', saveDraft);

    function importFiles(files: File[]): void {
        if (disposed || currentSync()?.sessionKey !== sessionKey || !files.length) return;
        if (isCanvasImportBatch(files)) postCanvasMessage({ type: 'paws-project-canvas/import-files', sessionKey, files });
        else postCanvasMessage({ type: 'paws-project-canvas/import-failed', sessionKey });
    }
    editor.registerExternalContentHandler('files', ({ files }) => importFiles(files));
    editor.registerExternalContentHandler('file-replace', ({ file }) => importFiles([file]));

    function imagePlacementsOnPage(): Map<string, TLShape> {
        const result = new Map<string, TLShape>();
        for (const shape of editor.getCurrentPageShapes()) {
            const key = keyOfShape(shape);
            if (key && !editor.isShapeHidden(shape) && (!result.has(key) || shape.id === shapeIdOf(key))) result.set(key, shape);
        }
        return result;
    }

    function estimateBounds(asset: ProjectCanvasRenderAsset): BoxLike {
        const shape = editor.getShape(shapeIdOf(canvasKey(asset)));
        return (shape && editor.getShapePageBounds(shape)) ?? { x: asset.x, y: asset.y, w: 380, h: 380 };
    }

    function inventoryBounds(): BoxLike | undefined {
        const existing = editor.getCurrentPageBounds();
        let left = existing?.x ?? Infinity;
        let top = existing?.y ?? Infinity;
        let right = existing?.maxX ?? -Infinity;
        let bottom = existing?.maxY ?? -Infinity;
        for (const [key, asset] of desired) {
            if (removed.has(key) || isFiltered(key) || editor.getShape(shapeIdOf(key))) continue;
            const bounds = estimateBounds(asset);
            left = Math.min(left, bounds.x);
            top = Math.min(top, bounds.y);
            right = Math.max(right, bounds.x + bounds.w);
            bottom = Math.max(bottom, bounds.y + bounds.h);
        }
        return Number.isFinite(left) ? { x: left, y: top, w: right - left, h: bottom - top } : undefined;
    }

    function requestVisibleAssets(quality: ProjectCanvasAssetQuality): void {
        if (disposed || desired.size === 0 || currentSync()?.sessionKey !== sessionKey) return;
        const zoom = editor.getZoomLevel();
        if (quality === 'original' && zoom < 1.25) return;
        const viewport = editor.getViewportPageBounds();
        if (viewport.w <= 0 || viewport.h <= 0) return;
        const padding = 36 / zoom;
        const placements = imagePlacementsOnPage();
        const candidates: Array<{ key: string; asset: ProjectCanvasRenderAsset; distance: number }> = [];
        for (const [key, asset] of desired) {
            if (isFiltered(key)) continue;
            const shape = placements.get(key);
            if (!shape && (removed.has(key) || editor.getShape(shapeIdOf(key)))) continue;
            const bounds = (shape && editor.getShapePageBounds(shape)) ?? estimateBounds(asset);
            if (bounds.x > viewport.maxX + padding || bounds.x + bounds.w < viewport.minX - padding
                || bounds.y > viewport.maxY + padding || bounds.y + bounds.h < viewport.minY - padding) continue;
            const dx = bounds.x + bounds.w / 2 - viewport.center.x;
            const dy = bounds.y + bounds.h / 2 - viewport.center.y;
            candidates.push({ key, asset, distance: dx * dx + dy * dy });
        }
        const isPreview = quality === 'preview';
        const requested = isPreview ? requestedPreviews : requestedOriginals;
        const limit = isPreview ? PROJECT_CANVAS_PREVIEW_REQUEST_MAX : PROJECT_CANVAS_ORIGINAL_REQUEST_MAX;
        const capacity = isPreview ? limit - pendingPreviews.size : limit;
        if (capacity <= 0) return;
        const ids = [];
        const ranked = candidates.sort((a, b) => a.distance - b.distance);
        // Preview arrivals release bounded capacity for the next nearest
        // visible image. Originals stay limited to an explicit zoom's window.
        for (const { key, asset } of isPreview ? ranked : ranked.slice(0, limit)) {
            if (requested.has(key) || (isPreview ? asset.uri !== undefined || failedPreviews.has(key) : asset.sourceQuality !== 'preview')) continue;
            requested.add(key);
            if (isPreview) pendingPreviews.add(key);
            ids.push(asset.id);
            if (ids.length === capacity) break;
        }
        if (ids.length) postCanvasMessage({ type: 'paws-project-canvas/request-assets', sessionKey, ids, quality });
    }

    function schedulePreviews(): void {
        if (previewFrame !== undefined || disposed) return;
        previewFrame = requestAnimationFrame(() => {
            previewFrame = undefined;
            requestVisibleAssets('preview');
        });
    }

    function requestAfterZoomIn(event: WheelEvent): void {
        if (wheelFrame !== undefined || !(event.target instanceof Element) || !event.target.closest('.tl-canvas')) return;
        const before = editor.getZoomLevel();
        wheelFrame = requestAnimationFrame(() => {
            wheelFrame = undefined;
            if (editor.getZoomLevel() > before) requestVisibleAssets('original');
        });
    }
    window.addEventListener('wheel', requestAfterZoomIn, { capture: true, passive: true });

    function shapePosition(shape: TLShape): { x: number; y: number } {
        const anchor = editor.getShapePageTransform(shape).applyToPoint({ x: 0, y: 0 });
        return { x: boundCoordinate(anchor.x), y: boundCoordinate(anchor.y) };
    }

    function alignShapes(keys: Iterable<string>, mode: 'legacy' | 'landed' | 'authoritative', before?: ReadonlyMap<string, ProjectCanvasRenderAsset>): void {
        const shapes: TLShapePartial<TLImageShape>[] = [];
        for (const key of keys) {
            const asset = desired.get(key);
            const shape = editor.getShape(shapeIdOf(key));
            if (!asset || shape?.type !== 'image') continue;
            const { pawsPlacementX, pawsPlacementY } = shape.meta;
            const actual = shapePosition(shape);
            const prior = before?.get(key);
            if (scene.hasLocalEdits() && prior && (prior.x !== actual.x || prior.y !== actual.y)) continue;
            // Older local snapshots have no last-applied placement. Retain
            // their edited geometry on hydration and record the server value
            // for future changes. Group members use parent-space coordinates.
            const applyPosition = (actual.x !== asset.x || actual.y !== asset.y)
                && (mode !== 'legacy' || (typeof pawsPlacementX === 'number' && typeof pawsPlacementY === 'number'));
            if (!applyPosition && pawsPlacementX === asset.x && pawsPlacementY === asset.y) continue;
            const position = applyPosition ? editor.getPointInParentSpace(shape, asset) : undefined;
            shapes.push({
                id: shape.id, type: shape.type,
                ...(position ? { x: position.x, y: position.y } : {}),
                meta: { ...shape.meta, pawsPlacementX: asset.x, pawsPlacementY: asset.y },
            });
        }
        if (!shapes.length) return;
        editor.store.mergeRemoteChanges(() => editor.run(() => {
            editor.updateShapes(shapes);
        }, { history: 'ignore', ignoreShapeLock: true }));
    }

    function applyDisplay(key: string, source: DisplayImage): void {
        if (disposed || currentSync()?.sessionKey !== sessionKey || !desired.has(key)) return;
        const id = imageAssetIdOf(key);
        const asset = editor.getAsset(id);
        if (asset && (asset.type !== 'image' || asset.props.src === source.dataUrl)) return;
        const bitmap: TLImageAsset = { id, typeName: 'asset', type: 'image',
            meta: { ...asset?.meta, pawsDisplayQuality: source.quality ?? 'preview' }, props: {
            name: asset?.props.name ?? desired.get(key)?.name ?? key,
            src: source.dataUrl, mimeType: source.mimeType, fileSize: source.length,
            isAnimated: source.mimeType === 'image/gif', w: source.width, h: source.height,
        } };
        // Keep the shape record, including local crop, transforms and group
        // membership. Only the shared bitmap gets new bytes.
        editor.store.mergeRemoteChanges(() => asset ? editor.updateAssets([bitmap]) : editor.createAssets([bitmap]));
    }

    async function hydrateDisplay(key: string, asset: ProjectCanvasRenderAsset): Promise<void> {
        const { uri } = asset;
        if (disposed || currentSync()?.sessionKey !== sessionKey || !uri || loading.get(key) === uri
            || failedDisplays.get(key) === uri) return;
        // A copied image can still refer to this bitmap after the canonical
        // placement has been removed. Hydrate that copy without restoring the
        // placement the user deleted.
        if (removed.has(key) && !imagePlacementsOnPage().has(key)) return;
        const cached = displays.get(key);
        if (cached?.uri === uri) {
            if (editor.getShape(shapeIdOf(key)) || removed.has(key)) {
                applyDisplay(key, cached);
                return;
            }
        }
        loading.set(key, uri);
        try {
            const source = cached?.uri === uri ? cached : await readDisplayImage(asset, uri);
            if (disposed || currentSync()?.sessionKey !== sessionKey || desired.get(key)?.uri !== uri) return;
            failedDisplays.delete(key);
            displays.set(key, source);
            if (editor.getShape(shapeIdOf(key)) || removed.has(key)) {
                applyDisplay(key, source);
            } else if (!queued.has(key)) {
                // The first placement still goes through the original Studio.
                queued.add(key);
                setAssetUri(key, uri);
                try {
                    await landTlItems(landingEditor, [landingOf(asset, source)], () => !disposed
                        && currentSync()?.sessionKey === sessionKey && desired.has(key) && !removed.has(key));
                } finally {
                    queued.delete(key);
                }
                if (!disposed && currentSync()?.sessionKey === sessionKey && desired.has(key) && !removed.has(key)) {
                    alignShapes([key], 'landed');
                    applyDisplay(key, displays.get(key) ?? source);
                    if (initialFit || requestedAsset) fitPlacedImages();
                }
            }
        } catch (error) {
            // A previous display remains live if a new source cannot decode.
            // Only replacement bytes can retry; incidental manifest syncs must
            // not repeatedly fetch/decode the same failing local bitmap.
            if (disposed || currentSync()?.sessionKey !== sessionKey || desired.get(key)?.uri !== uri) return;
            failedDisplays.set(key, uri);
            console.warn('Project canvas could not display an image.', error instanceof Error ? error.name : 'UnknownError');
        } finally {
            if (loading.get(key) === uri) loading.delete(key);
        }
    }

    function fitPlacedImages(): void {
        if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(() => {
            fitFrame = undefined;
            if (disposed || currentSync()?.sessionKey !== sessionKey) return;
            if (requestedAsset && focusAsset(requestedAsset)) {
                requestedAsset = undefined;
                initialFit = false;
                return;
            }
            initialFit = !fitCanvasBounds(editor, inventoryBounds());
            schedulePreviews();
        });
    }

    function focusAsset(id: string): boolean {
        const asset = currentSync()?.assets.find(candidate => candidate.id === id);
        if (!asset || isFiltered(canvasKey(asset))) return false;
        const key = canvasKey(asset);
        const shape = imagePlacementsOnPage().get(key) ?? editor.getShape(shapeIdOf(key));
        if (!shape) return false;
        const bounds = editor.getShapePageBounds(shape);
        if (!bounds) return false;
        const page = editor.getAncestorPageId(shape);
        editor.store.mergeRemoteChanges(() => {
            // A page change can reveal an existing selection. Publish the
            // highlight without treating it as interaction with the composer.
            if (page && page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
            fitCanvasBounds(editor, bounds, 1.5);
        });
        return true;
    }

    const stopCommands = subscribeCommand(command => {
        if (disposed || command.sessionKey !== sessionKey) return;
        if (command.action === 'flush-scene') {
            scene.flush(command.requestId);
            return;
        }
        if (command.action === 'retry-scene') {
            scene.retry();
            return;
        }
        if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
        fitFrame = undefined;
        initialFit = false;
        requestedAsset = undefined;
        if (command.action === 'focus-asset') {
            if (!focusAsset(command.assetId)) requestedAsset = command.assetId;
        } else if (command.action === 'fit') {
            fitCanvasBounds(editor, inventoryBounds());
            schedulePreviews();
        } else if (command.action === 'zoom-in') {
            editor.zoomIn(undefined, { immediate: true });
            requestVisibleAssets('original');
        } else {
            editor.zoomOut(undefined, { immediate: true });
        }
    });

    function removeOrphans(): void {
        const orphanIds: TLShapeId[] = [];
        const orphanBitmapIds: TLAssetId[] = [];
        for (const record of editor.store.allRecords()) {
            if (record.typeName === 'shape') {
                const key = keyOfShape(record);
                if (key && !desired.has(key)) orphanIds.push(record.id);
            } else if (record.typeName === 'asset' && record.id.startsWith('asset:ig-')) {
                const key = record.id.slice('asset:ig-'.length);
                if (managedAssetKey.test(key) && !desired.has(key)) orphanBitmapIds.push(record.id);
            }
        }
        if (orphanIds.length || orphanBitmapIds.length) {
            editor.store.mergeRemoteChanges(() => editor.run(() => {
                editor.deleteShapes(orphanIds);
                editor.deleteAssets(orphanBitmapIds);
            }, { history: 'ignore', ignoreShapeLock: true }));
        }
    }

    // SDK record effects run synchronously. Export and background-tab
    // transitions can observe edits before the next animation frame.
    const effects = editor.store.sideEffects;
    const changeHandlers = [...editor.store.scopedTypes.document].flatMap(type => [
        effects.registerAfterCreateHandler(type, (record, source) => {
            if (source !== 'user' || disposed) return;
            const key = record.typeName === 'shape' ? keyOfShape(record) : undefined;
            if (key && record.id === shapeIdOf(key)) removed.delete(key);
            scene.trackUserEdit();
        }),
        effects.registerAfterChangeHandler(type, (_before, _after, source) => {
            if (source === 'user' && !disposed) scene.trackUserEdit();
        }),
        effects.registerAfterDeleteHandler(type, (record, source) => {
            if (source !== 'user' || disposed) return;
            const key = record.typeName === 'shape' ? keyOfShape(record) : undefined;
            if (key && record.id === shapeIdOf(key) && desired.has(key)) removed.add(key);
            scene.trackUserEdit();
        }),
    ]);

    const stopViewport = editor.store.listen(({ changes }) => {
        if (Object.values(changes.updated).some(([before, after]) => {
            if (before.typeName === 'camera' && after.typeName === 'camera') {
                return before.x !== after.x || before.y !== after.y || before.z !== after.z;
            }
            return before.typeName === 'instance' && after.typeName === 'instance'
                && (before.currentPageId !== after.currentPageId || before.screenBounds !== after.screenBounds);
        })) schedulePreviews();
    }, { source: 'all', scope: 'session' });

    async function syncAssets(): Promise<void> {
        const update = currentSync();
        if (disposed || update?.sessionKey !== sessionKey) return;
        const nextPaletteState = update.palette ? JSON.stringify([update.theme, update.palette]) : '';
        if (studioTheme && paletteState !== nextPaletteState) {
            paletteState = nextPaletteState;
            const palette = update.palette;
            editor.updateTheme(palette ? {
                ...studioTheme,
                colors: {
                    ...studioTheme.colors,
                    [update.theme]: {
                        ...studioTheme.colors[update.theme],
                        text: palette.text,
                        background: palette.background,
                        negativeSpace: palette.background,
                        selectionStroke: palette.accent,
                    },
                },
            } : studioTheme);
        }
        const previous = desired;
        desired = new Map(update.assets.map(asset => [canvasKey(asset), asset]));
        const nextFailures = new Set((update.previewRequestFailures ?? [])
            .map(asset => `${asset.id}-${asset.versionId}`).filter(key => desired.has(key)));
        let previewProgress = false;
        for (const key of failedPreviews) {
            if (!nextFailures.has(key)) {
                // The parent only clears a terminal failure on explicit retry
                // or version change. Unrelated sync events cannot retry it.
                requestedPreviews.delete(key);
                previewProgress = true;
            }
        }
        failedPreviews = nextFailures;
        for (const key of pendingPreviews) {
            if (!desired.has(key) || desired.get(key)?.uri || failedPreviews.has(key)) {
                pendingPreviews.delete(key);
                previewProgress = true;
            }
        }
        const nextFilter = update.visibleAssetIds ? [...update.visibleAssetIds].sort().join('|') : undefined;
        const filterChanged = nextFilter !== filterKey;
        filterKey = nextFilter;
        if (filterChanged) {
            visibleAssets.set(update.visibleAssetIds ? new Set(update.visibleAssetIds) : undefined);
            const selected = editor.getSelectedShapeIds();
            const visible = selected.filter(id => !editor.isShapeHidden(id));
            if (visible.length !== selected.length) editor.store.mergeRemoteChanges(() => editor.setSelectedShapes(visible));
        }
        const sceneRestored = scene.accept(update.scene);
        // URI-only syncs omit the unchanged document. Its accepted revision
        // still governs placement updates until an actual scene is supplied.
        const sameSceneRevision = !update.scene || sceneRevision === update.scene.revision;
        if (update.scene) sceneRevision = update.scene.revision;
        for (const [key, asset] of previous) {
            if (desired.has(key)) continue;
            removeAssetUri(key);
            queued.delete(key);
            loading.delete(key);
            displays.delete(key);
            failedDisplays.delete(key);
            requestedPreviews.delete(key);
            pendingPreviews.delete(key);
            requestedOriginals.delete(key);
            removed.delete(key);
        }
        removeOrphans();
        const positioned = update.assets.filter(asset => {
            const before = previous.get(canvasKey(asset));
            return !before || before.x !== asset.x || before.y !== asset.y;
        });
        if (sceneRestored && !scene.hasLocalEdits()) alignShapes(desired.keys(), 'authoritative');
        else if (sameSceneRevision) {
            alignShapes(positioned.map(canvasKey), sceneRevision !== undefined ? 'authoritative' : 'legacy', previous);
        }
        if (positioned.length || previous.size !== desired.size || sceneRestored || filterChanged || previewProgress) {
            if (sceneRestored || filterChanged || (initialFit && desired.size)) fitPlacedImages();
            else schedulePreviews();
        }
        for (const [key, asset] of desired) {
            await hydrateDisplay(key, asset);
        }
    }
    const stopSync = subscribeSync(() => { void syncAssets(); });
    void syncAssets();

    return () => {
        disposed = true;
        if (mountedEditor === editor) mountedEditor = undefined;
        if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
        if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
        if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame);
        scene.dispose();
        visibleAssets.set(undefined);
        window.removeEventListener('pointerdown', beforePointerDown, true);
        window.removeEventListener('pointerup', afterPointerUp);
        window.removeEventListener('pointercancel', afterPointerUp);
        window.removeEventListener('blur', clearPointer);
        window.removeEventListener('pagehide', saveDraft);
        window.removeEventListener('wheel', requestAfterZoomIn, true);
        stopCommands();
        stopSceneResults();
        stopSync();
        for (const stopChanges of changeHandlers) stopChanges();
        stopViewport();
        for (const key of desired.keys()) removeAssetUri(key);
    };
}
