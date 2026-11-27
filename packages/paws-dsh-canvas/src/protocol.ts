export const PROJECT_CANVAS_CHANNEL = 'paws-project-canvas';

export type ProjectCanvasImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type ProjectCanvasAssetQuality = 'preview' | 'original';

export interface ProjectCanvasPlacement {
    id: string;
    x: number;
    y: number;
}

export interface ProjectCanvasRenderAsset extends ProjectCanvasPlacement {
    versionId: string;
    name: string;
    mimeType: ProjectCanvasImageMime;
    uri?: string;
    size?: number;
    displayMimeType?: ProjectCanvasImageMime;
    displaySize?: number;
    sourceQuality?: ProjectCanvasAssetQuality;
}

export interface ProjectCanvasScene {
    revision: number;
    document: string;
}

export interface ProjectCanvasReviewMark {
    id: string;
    number: number;
    pageId: string;
    bounds: { x: number; y: number; w: number; h: number };
    ids: string[];
}

export interface ProjectCanvasReviewState {
    scope: string;
    marks: ProjectCanvasReviewMark[];
    capacity: number;
    nextNumber: number;
    rejectedId?: string;
}

export interface ProjectCanvasSync {
    type: 'paws-project-canvas/sync';
    sessionKey: string;
    assets: ProjectCanvasRenderAsset[];
    manifestRevision?: number;
    theme: 'light' | 'dark';
    locale?: 'zh' | 'en';
    licenseKey?: string;
    palette?: ProjectCanvasPalette;
    scene?: ProjectCanvasScene;
    visibleAssetIds?: string[];
    /** Terminal preview requests for this session; cleared only for explicit retry or a new version. */
    previewRequestFailures?: Array<{ id: string; versionId: string }>;
    review?: ProjectCanvasReviewState;
}

export interface ProjectCanvasPalette {
    background: string;
    surface: string;
    text: string;
    divider: string;
    accent: string;
    surfaceSelected: string;
}

type ProjectCanvasCommandScope = {
    type: 'paws-project-canvas/command';
    sessionKey: string;
};

export type ProjectCanvasCommand = ProjectCanvasCommandScope & (
    | { action: 'fit' | 'zoom-in' | 'zoom-out' | 'retry-scene' }
    | { action: 'focus-asset'; assetId: string }
    | { action: 'flush-scene'; requestId: string }
);

export type ProjectCanvasSceneResult =
    | { type: 'paws-project-canvas/scene-saved'; sessionKey: string; revision: number }
    | { type: 'paws-project-canvas/scene-failed'; sessionKey: string; reason: 'conflict' | 'save' };

export type ProjectCanvasFrameMessage =
    | { type: 'paws-project-canvas/ready' }
    | { type: 'paws-project-canvas/select'; sessionKey: string; ids: string[] }
    | { type: 'paws-project-canvas/selection'; sessionKey: string; ids: string[] }
    | { type: 'paws-project-canvas/request-assets'; sessionKey: string; ids: string[]; quality: ProjectCanvasAssetQuality }
    | { type: 'paws-project-canvas/layout'; sessionKey: string; placements: ProjectCanvasPlacement[] }
    | ({ type: 'paws-project-canvas/scene'; sessionKey: string; placements: ProjectCanvasPlacement[] } & ProjectCanvasScene)
    | { type: 'paws-project-canvas/scene-flushed'; sessionKey: string; requestId: string; ok: boolean }
    | { type: 'paws-project-canvas/scene-error'; sessionKey: string; reason: 'conflict' | 'save' | 'invalid' }
    | { type: 'paws-project-canvas/import-files'; sessionKey: string; files: File[] }
    | { type: 'paws-project-canvas/import-failed'; sessionKey: string }
    | { type: 'paws-project-canvas/review-mark'; sessionKey: string; reviewScope: string; mark: ProjectCanvasReviewMark; expiresAt: number; dataUrl: string }
    | { type: 'paws-project-canvas/clip'; sessionKey: string; ids: string[]; dataUrl: string };

const assetId = /^asset-[a-f0-9]{64}$/;
const versionId = /^[a-f0-9]{64}$/;
const imageTypes = new Set<unknown>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxAssets = 160;
const maxReviewMarks = 50;
export const PROJECT_CANVAS_PREVIEW_REQUEST_MAX = 16;
export const PROJECT_CANVAS_ORIGINAL_REQUEST_MAX = 4;
export const PROJECT_CANVAS_REVIEW_ACK_TIMEOUT_MS = 30_000;
export const PROJECT_CANVAS_SCENE_DOCUMENT_MAX_BYTES = 384 * 1024;
export const PROJECT_CANVAS_SCENE_DOCUMENT_VERSION = 1;
const maxCoordinate = 1_000_000;
const maxClipLength = 5_400_000;
const paletteKeys: ReadonlyArray<keyof ProjectCanvasPalette> = ['background', 'surface', 'text', 'divider', 'accent', 'surfaceSelected'];
const safeColor = /^(?:#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})|rgba?\([\d., /%]+\)|transparent)$/i;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyOf(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function isCoordinate(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxCoordinate;
}

function placement(value: unknown): value is ProjectCanvasPlacement {
    return record(value) && typeof value.id === 'string' && assetId.test(value.id)
        && isCoordinate(value.x) && isCoordinate(value.y);
}

function placementsOf(value: unknown): value is ProjectCanvasPlacement[] {
    return Array.isArray(value) && value.length <= maxAssets && value.every(placement)
        && new Set(value.map(item => item.id)).size === value.length;
}

function isSceneRevision(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isProjectCanvasDocument(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= PROJECT_CANVAS_SCENE_DOCUMENT_MAX_BYTES
        && new TextEncoder().encode(value).length <= PROJECT_CANVAS_SCENE_DOCUMENT_MAX_BYTES;
}

function validScene(value: unknown): value is ProjectCanvasScene {
    return record(value) && isSceneRevision(value.revision) && value.revision > 0 && isProjectCanvasDocument(value.document);
}

function validUri(value: unknown, origin: string): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
    try {
        const url = new URL(value, origin);
        return url.origin === origin && !url.username && !url.password
            && ['blob:', 'http:', 'https:'].includes(url.protocol);
    } catch {
        return false;
    }
}

function renderAsset(value: unknown, origin: string): value is ProjectCanvasRenderAsset {
    if (!record(value)) return false;
    const { name, uri, versionId: version, mimeType, size, displayMimeType, displaySize, sourceQuality } = value;
    return placement(value) && typeof version === 'string' && versionId.test(version)
        && typeof name === 'string' && name.length > 0 && name.length <= 160
        && (size === undefined || isAssetSize(size)) && (displaySize === undefined || isAssetSize(displaySize))
        && (sourceQuality === undefined || sourceQuality === 'original' || sourceQuality === 'preview')
        && (displayMimeType === undefined || imageTypes.has(displayMimeType))
        && imageTypes.has(mimeType) && (uri === undefined || validUri(uri, origin));
}

function isAssetSize(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 12 * 1024 * 1024;
}

function previewFailures(value: unknown): boolean {
    return Array.isArray(value) && value.length <= maxAssets
        && value.every(item => record(item) && typeof item.id === 'string' && assetId.test(item.id)
            && typeof item.versionId === 'string' && versionId.test(item.versionId))
        && new Set(value.map(item => `${item.id}-${item.versionId}`)).size === value.length;
}

export function isCanvasImportBatch(value: unknown): value is File[] {
    return Array.isArray(value) && value.length > 0 && value.length <= maxAssets && typeof File !== 'undefined'
        && value.every(file => file instanceof File && imageTypes.has(file.type) && isAssetSize(file.size)
            && file.name.length > 0 && file.name.length <= 160);
}

function idsOf(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= maxAssets
        && value.every(id => typeof id === 'string' && assetId.test(id))
        && new Set(value).size === value.length;
}

function reviewId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);
}

function reviewNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function reviewMark(value: unknown): value is ProjectCanvasReviewMark {
    if (!record(value) || !reviewId(value.id) || !reviewNumber(value.number)
        || typeof value.pageId !== 'string' || !/^page:[A-Za-z0-9_-]{1,120}$/.test(value.pageId)
        || !idsOf(value.ids) || !record(value.bounds)) return false;
    const { x, y, w, h } = value.bounds;
    return isCoordinate(x) && isCoordinate(y) && isCoordinate(w) && isCoordinate(h)
        && ((w === 0 && h === 0) || (w > 0 && h > 0))
        && isCoordinate(x + w) && isCoordinate(y + h);
}

function validReview(value: unknown): value is ProjectCanvasReviewState {
    return record(value) && keyOf(value.scope) && reviewNumber(value.nextNumber)
        && typeof value.capacity === 'number' && Number.isSafeInteger(value.capacity) && value.capacity >= 0 && value.capacity <= maxReviewMarks
        && Array.isArray(value.marks) && value.marks.length <= maxReviewMarks && value.marks.every(reviewMark)
        && new Set(value.marks.map(mark => mark.id)).size === value.marks.length
        && new Set(value.marks.map(mark => mark.number)).size === value.marks.length
        && (value.rejectedId === undefined || reviewId(value.rejectedId));
}

function clipDataUrl(value: unknown): value is string {
    return typeof value === 'string' && value.length <= maxClipLength
        && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function validPalette(value: unknown): value is ProjectCanvasPalette {
    if (!record(value) || Object.keys(value).length !== paletteKeys.length) return false;
    return paletteKeys.every(key => {
        const color = value[key];
        return typeof color === 'string' && color.length <= 64 && safeColor.test(color);
    });
}

export function readProjectCanvasSync(value: unknown, origin: string): ProjectCanvasSync | undefined {
    if (!record(value) || value.type !== 'paws-project-canvas/sync' || !keyOf(value.sessionKey)
        || !Array.isArray(value.assets) || value.assets.length > maxAssets
        || (value.theme !== 'light' && value.theme !== 'dark')
        || (value.locale !== undefined && value.locale !== 'zh' && value.locale !== 'en')
        || (value.licenseKey !== undefined && (typeof value.licenseKey !== 'string' || value.licenseKey.length > 4096))
        || (value.palette !== undefined && !validPalette(value.palette))
        || (value.manifestRevision !== undefined && !isSceneRevision(value.manifestRevision))
        || (value.scene !== undefined && !validScene(value.scene))
        || (value.visibleAssetIds !== undefined && !idsOf(value.visibleAssetIds))
        || (value.previewRequestFailures !== undefined && !previewFailures(value.previewRequestFailures))
        || (value.review !== undefined && !validReview(value.review))
        || !value.assets.every(asset => renderAsset(asset, origin))) return undefined;
    if (new Set(value.assets.map(asset => asset.id)).size !== value.assets.length) return undefined;
    return value as unknown as ProjectCanvasSync;
}

export function readProjectCanvasCommand(value: unknown): ProjectCanvasCommand | undefined {
    if (!record(value) || value.type !== 'paws-project-canvas/command' || !keyOf(value.sessionKey)) return undefined;
    const { action, assetId: target, sessionKey } = value;
    if (action === 'focus-asset' && typeof target === 'string' && assetId.test(target)) {
        return { type: value.type, sessionKey, action, assetId: target };
    }
    if (action === 'flush-scene' && keyOf(value.requestId)) return { type: value.type, sessionKey, action, requestId: value.requestId };
    if ((action === 'fit' || action === 'zoom-in' || action === 'zoom-out' || action === 'retry-scene') && target === undefined) {
        return { type: value.type, sessionKey, action };
    }
    return undefined;
}

export function readProjectCanvasSceneResult(value: unknown): ProjectCanvasSceneResult | undefined {
    if (!record(value) || !keyOf(value.sessionKey)) return undefined;
    if (value.type === 'paws-project-canvas/scene-saved' && isSceneRevision(value.revision) && value.revision > 0) {
        return { type: value.type, sessionKey: value.sessionKey, revision: value.revision };
    }
    if (value.type === 'paws-project-canvas/scene-failed' && (value.reason === 'conflict' || value.reason === 'save')) {
        return { type: value.type, sessionKey: value.sessionKey, reason: value.reason };
    }
    return undefined;
}

export function readProjectCanvasFrameMessage(value: unknown): ProjectCanvasFrameMessage | undefined {
    if (!record(value)) return undefined;
    if (value.type === 'paws-project-canvas/ready') return { type: value.type };
    if (!keyOf(value.sessionKey)) return undefined;
    const sessionKey = value.sessionKey;
    if ((value.type === 'paws-project-canvas/select' || value.type === 'paws-project-canvas/selection') && idsOf(value.ids)) {
        return { type: value.type, sessionKey, ids: value.ids };
    }
    if (value.type === 'paws-project-canvas/request-assets' && idsOf(value.ids) && value.ids.length > 0) {
        const quality = value.quality;
        if ((quality === 'preview' && value.ids.length <= PROJECT_CANVAS_PREVIEW_REQUEST_MAX)
            || (quality === 'original' && value.ids.length <= PROJECT_CANVAS_ORIGINAL_REQUEST_MAX)) {
            return { type: value.type, sessionKey, ids: value.ids, quality };
        }
    }
    if (value.type === 'paws-project-canvas/layout' && placementsOf(value.placements) && value.placements.length > 0) {
        return { type: value.type, sessionKey, placements: value.placements };
    }
    if (value.type === 'paws-project-canvas/scene' && isSceneRevision(value.revision)
        && isProjectCanvasDocument(value.document) && placementsOf(value.placements)) {
        return { type: value.type, sessionKey, revision: value.revision, document: value.document, placements: value.placements };
    }
    if (value.type === 'paws-project-canvas/scene-flushed' && keyOf(value.requestId) && typeof value.ok === 'boolean') {
        return { type: value.type, sessionKey, requestId: value.requestId, ok: value.ok };
    }
    if (value.type === 'paws-project-canvas/scene-error'
        && (value.reason === 'conflict' || value.reason === 'save' || value.reason === 'invalid')) {
        return { type: value.type, sessionKey, reason: value.reason };
    }
    if (value.type === 'paws-project-canvas/import-files' && isCanvasImportBatch(value.files)) {
        return { type: value.type, sessionKey, files: value.files };
    }
    if (value.type === 'paws-project-canvas/import-failed') return { type: value.type, sessionKey };
    if (value.type === 'paws-project-canvas/review-mark' && keyOf(value.reviewScope)
        && reviewMark(value.mark) && reviewNumber(value.expiresAt) && clipDataUrl(value.dataUrl)) {
        return { type: value.type, sessionKey, reviewScope: value.reviewScope, mark: value.mark, expiresAt: value.expiresAt, dataUrl: value.dataUrl };
    }
    if (value.type === 'paws-project-canvas/clip' && idsOf(value.ids) && clipDataUrl(value.dataUrl)) {
        return { type: value.type, sessionKey, ids: value.ids, dataUrl: value.dataUrl };
    }
    return undefined;
}
