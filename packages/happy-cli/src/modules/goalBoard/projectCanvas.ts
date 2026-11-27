import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GOAL_CANVAS_LIMITS, GoalProjectCanvasRequests, GoalProjectCanvasSchema, type GoalProjectCanvas,
    type GoalProjectCanvasBundle, type GoalProjectCanvasCategory, type GoalProjectCanvasChange,
    type GoalProjectCanvasChangeNotice } from '@slopus/happy-wire';
import { openAuthorizedFile } from './authorizedFiles';
import { detectCodexImage } from '../../codex/codexImageInput';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_OPEN_UPLOADS = 4;
const MAX_COMPLETED_UPLOADS = 32;
const UPLOAD_LIFETIME_MS = 10 * 60_000;
const BUNDLE_LIFETIME_MS = 60 * 60_000;
const MAX_STAGED_BUNDLES_PER_PROJECT = 4;
const BUNDLE_DIRECTORY = 'bundle-staging';
const staleProject = 'Canvas has changed. Refresh before saving layout.';
const manifestOperations = new Map<string, Promise<unknown>>();

type ProjectStore = { id: string; directory: string; manifest: string };
type CanvasAsset = GoalProjectCanvas['assets'][number];
type ImageInput = { name: string; mimeType: CanvasAsset['mimeType'] };
type UploadDetails = ImageInput & { totalSize: number };
type CanvasResult = { success: true; canvas: GoalProjectCanvas };
type Upload = UploadDetails & { bytes: Buffer; nextOffset: number; updatedAt: number; completing?: Promise<CanvasResult> };
type CompletedUpload = UploadDetails & { offset: number; hash: string; updatedAt: number };
type Bitmap = Pick<CanvasAsset, 'mimeType' | 'size' | 'versionId'>;
type Placement = Pick<CanvasAsset, 'id' | 'x' | 'y'>;
type StagedUpload = { mimeType: Bitmap['mimeType']; totalSize: number; bytes: Buffer; nextOffset: number; updatedAt: number };

async function privateDirectory(path: string) {
    await mkdir(path, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Canvas storage directory is unavailable');
    return path;
}

async function atomicWrite(path: string, bytes: string | Buffer) {
    const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try {
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    }
}

async function readCanvas(store: ProjectStore): Promise<GoalProjectCanvas> {
    let source: Awaited<ReturnType<typeof openAuthorizedFile>>;
    try {
        source = await openAuthorizedFile(store.directory, store.manifest, MAX_MANIFEST_BYTES);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // An absent manifest is an empty canvas. A dangling link is invalid state.
        if (await lstat(store.manifest).then(() => true, error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        })) throw new Error('Canvas manifest path is invalid');
        return { id: store.id, revision: 0, assets: [] };
    }
    try {
        if (source.actual !== store.manifest) throw new Error('Canvas manifest path is invalid');
        const bytes = Buffer.alloc(source.info.size);
        const { bytesRead } = await source.handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length) throw new Error('Canvas manifest changed during read');
        const canvas = GoalProjectCanvasSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (canvas.id !== store.id || new Set(canvas.assets.map(asset => asset.id)).size !== canvas.assets.length ||
            canvas.assets.some(asset => asset.id !== 'asset-' + asset.versionId)) throw new Error('Canvas manifest does not match its project');
        const categories = new Map((canvas.categories ?? []).map(category => [category.id, category]));
        if (categories.size !== (canvas.categories?.length ?? 0)) throw new Error('Canvas category IDs are duplicated');
        validateMetadata(canvas.assets, categories);
        return canvas;
    } finally {
        await source.handle.close();
    }
}

function validateMetadata(assets: CanvasAsset[], categories: ReadonlyMap<string, GoalProjectCanvasCategory>) {
    if (categories.size > GOAL_CANVAS_LIMITS.categories) throw new Error('Canvas category limit reached');
    if (assets.length > GOAL_CANVAS_LIMITS.assets) throw new Error('Canvas image limit reached');
    if (assets.some(asset => asset.categoryId !== undefined && !categories.has(asset.categoryId))) {
        throw new Error('Canvas image category is unavailable in this project');
    }
}

const documentRecordTypes = new Set(['asset', 'binding', 'document', 'page', 'shape', 'user']);
const richTextResourceFields = new Set(['href', 'src', 'srcset', 'poster', 'url']);
const managedSceneAsset = /^asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
const managedSceneBitmap = /^asset:ig-asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
const managedSceneShape = /^shape:ig-asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
// Serialized schema of the default Paws renderer store pinned to tldraw 5.3.0.
// A newer sequence or shape type needs support in that renderer before it can
// replace the project's active scene.
const sceneSequenceVersions = new Map(Object.entries({
    'com.tldraw.store': 5,
    'com.tldraw.asset': 1,
    'com.tldraw.camera': 1,
    'com.tldraw.document': 2,
    'com.tldraw.instance': 26,
    'com.tldraw.instance_page_state': 5,
    'com.tldraw.page': 1,
    'com.tldraw.instance_presence': 6,
    'com.tldraw.pointer': 1,
    'com.tldraw.shape': 4,
    'com.tldraw.user': 1,
    'com.tldraw.asset.image': 6,
    'com.tldraw.asset.video': 5,
    'com.tldraw.asset.bookmark': 2,
    'com.tldraw.shape.group': 0,
    'com.tldraw.shape.text': 4,
    'com.tldraw.shape.bookmark': 2,
    'com.tldraw.shape.draw': 5,
    'com.tldraw.shape.geo': 12,
    'com.tldraw.shape.note': 13,
    'com.tldraw.shape.line': 5,
    'com.tldraw.shape.frame': 1,
    'com.tldraw.shape.arrow': 8,
    'com.tldraw.shape.highlight': 4,
    'com.tldraw.shape.embed': 4,
    'com.tldraw.shape.image': 5,
    'com.tldraw.shape.video': 4,
    'com.tldraw.binding.arrow': 1,
}));
const inlineRasterSource = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const unsafeSceneResource = 'Canvas scene images must use persistent asset references';

function sceneObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteSceneNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function validateSceneAsset(id: string, type: unknown, props: Record<string, unknown>, meta: Record<string, unknown>) {
    if ((type === 'image' || type === 'video') && (!finiteSceneNumber(props.w) || !finiteSceneNumber(props.h) ||
        typeof props.name !== 'string' || typeof props.isAnimated !== 'boolean' || (props.mimeType !== null && typeof props.mimeType !== 'string'))) {
        throw new Error('Invalid project canvas asset properties');
    }
    if (type === 'image') {
        if ('pawsDisplayQuality' in meta) throw new Error(unsafeSceneResource);
        if (props.src === null) return;
        if (managedSceneBitmap.test(id) || typeof props.src !== 'string') throw new Error(unsafeSceneResource);
        const match = inlineRasterSource.exec(props.src);
        if (!match) throw new Error(unsafeSceneResource);
        const [, mimeType, base64] = match;
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.toString('base64') !== base64 || detectCodexImage(bytes)?.mime !== mimeType) {
            throw new Error('Canvas scene inline image bytes do not match their raster format');
        }
        return;
    }
    if (managedSceneBitmap.test(id)) throw new Error('Invalid project canvas image reference');
    if (type === 'bookmark') {
        if (typeof props.title !== 'string' || typeof props.description !== 'string') throw new Error('Invalid project canvas asset properties');
        if (props.src !== null || props.image !== '' || props.favicon !== '') throw new Error(unsafeSceneResource);
    } else if (type === 'video') {
        if (props.src !== null) throw new Error(unsafeSceneResource);
    } else {
        throw new Error('Invalid project canvas asset type');
    }
}

function validateSceneRichText(value: unknown) {
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
        const { value, depth } = pending.pop()!;
        if (depth > 64) throw new Error('Project canvas text is nested too deeply');
        if (Array.isArray(value)) {
            for (const child of value) pending.push({ value: child, depth: depth + 1 });
        } else if (sceneObject(value)) {
            for (const [key, child] of Object.entries(value)) {
                if (richTextResourceFields.has(key.toLowerCase()) && child !== '') throw new Error(unsafeSceneResource);
                pending.push({ value: child, depth: depth + 1 });
            }
        }
    }
}

function validateSceneShape(record: Record<string, unknown>, props: Record<string, unknown>, meta: Record<string, unknown>, records: ReadonlyMap<string, Record<string, unknown>>) {
    const { id, type, index, parentId, x, y, rotation, opacity, isLocked } = record;
    if (typeof type !== 'string' || !sceneSequenceVersions.has('com.tldraw.shape.' + type)) {
        throw new Error('Unsupported project canvas shape type');
    }
    if (typeof id !== 'string' || typeof index !== 'string' || !index ||
        typeof parentId !== 'string' || typeof isLocked !== 'boolean' ||
        ![x, y, rotation].every(finiteSceneNumber) || !finiteSceneNumber(opacity) || opacity < 0 || opacity > 1) {
        throw new Error('Invalid project canvas shape');
    }
    if ('url' in props && props.url !== '') throw new Error(unsafeSceneResource);
    if ('richText' in props) validateSceneRichText(props.richText);
    const canonical = managedSceneShape.test(id);
    const galleryId = typeof meta.galleryId === 'string' && managedSceneAsset.test(meta.galleryId) ? meta.galleryId : undefined;
    if (canonical || galleryId) {
        if (type !== 'image' || !galleryId || props.assetId !== `asset:ig-${galleryId}` || (canonical && id !== `shape:ig-${galleryId}`)) {
            throw new Error('Invalid project canvas image reference');
        }
    }
    if (type === 'image' || type === 'video' || type === 'bookmark') {
        if (props.assetId === null) return;
        const asset = typeof props.assetId === 'string' ? records.get(props.assetId) : undefined;
        if (asset?.typeName !== 'asset' || asset.type !== type) throw new Error('Missing asset in project canvas shape');
    }
}

function validateSceneDocument(document: string) {
    if (Buffer.byteLength(document, 'utf8') > GOAL_CANVAS_LIMITS.sceneBytes) throw new Error('Canvas scene is too large');
    let value: unknown;
    try { value = JSON.parse(document); } catch { throw new Error('Canvas scene must be a JSON object'); }
    if (!sceneObject(value)) throw new Error('Canvas scene must be a JSON object');
    if (value.version !== 1 || !sceneObject(value.schema) || value.schema.schemaVersion !== 2 ||
        !sceneObject(value.schema.sequences) || !sceneObject(value.store) || !Array.isArray(value.removed) ||
        value.removed.length > GOAL_CANVAS_LIMITS.assets || new Set(value.removed).size !== value.removed.length ||
        !value.removed.every(key => typeof key === 'string' && managedSceneAsset.test(key))) {
        throw new Error('Invalid project canvas document');
    }
    const sequences = Object.entries(value.schema.sequences);
    if (sequences.some(([id, revision]) => {
        const supported = sceneSequenceVersions.get(id);
        return supported === undefined || !finiteSceneNumber(revision) || !Number.isSafeInteger(revision)
            || revision < 0 || revision > supported;
    })) {
        throw new Error('Invalid project canvas schema');
    }

    const records = new Map<string, Record<string, unknown>>();
    let hasPage = false;
    for (const [id, record] of Object.entries(value.store)) {
        if (!sceneObject(record) || record.id !== id || typeof record.typeName !== 'string' ||
            !documentRecordTypes.has(record.typeName) || !id.startsWith(record.typeName + ':') ||
            id.length <= record.typeName.length + 1 || id.length > 1024 || !sceneObject(record.meta)) {
            throw new Error('Invalid project canvas record');
        }
        if (record.typeName === 'document' && (id !== 'document:document' || typeof record.name !== 'string' || !finiteSceneNumber(record.gridSize))) {
            throw new Error('Invalid project canvas document record');
        }
        if (record.typeName === 'page') {
            if (typeof record.name !== 'string' || typeof record.index !== 'string' || !record.index) {
                throw new Error('Invalid project canvas page');
            }
            hasPage = true;
        }
        if (record.typeName === 'user' && (typeof record.name !== 'string' || typeof record.color !== 'string' || record.imageUrl !== '')) {
            throw new Error('Invalid project canvas user record');
        }
        records.set(id, record);
    }
    if (!hasPage || !records.has('document:document')) throw new Error('Project canvas is missing its document or pages');

    const attached = new Set<string>();
    for (const [id, record] of records) {
        if (record.typeName === 'document' || record.typeName === 'page' || record.typeName === 'user') continue;
        if (!sceneObject(record.props) || !sceneObject(record.meta)) throw new Error('Invalid project canvas record properties');
        if (record.typeName === 'asset') {
            validateSceneAsset(id, record.type, record.props, record.meta);
        } else if (record.typeName === 'binding') {
            if (typeof record.type !== 'string' || !sceneSequenceVersions.has('com.tldraw.binding.' + record.type)) {
                throw new Error('Unsupported project canvas binding type');
            }
            if (typeof record.fromId !== 'string' || records.get(record.fromId)?.typeName !== 'shape' ||
                typeof record.toId !== 'string' || records.get(record.toId)?.typeName !== 'shape') {
                throw new Error('Missing shape in project canvas binding');
            }
        } else {
            validateSceneShape(record, record.props, record.meta, records);
            const path = new Set<string>();
            let ancestor: Record<string, unknown> | undefined = record;
            while (ancestor?.typeName === 'shape' && typeof ancestor.id === 'string' && !attached.has(ancestor.id)) {
                if (path.has(ancestor.id) || path.size > 128) throw new Error('Invalid project canvas shape ancestry');
                path.add(ancestor.id);
                ancestor = typeof ancestor.parentId === 'string' ? records.get(ancestor.parentId) : undefined;
            }
            if (!ancestor || (ancestor.typeName !== 'page' && (typeof ancestor.id !== 'string' || !attached.has(ancestor.id)))) {
                throw new Error('Missing parent in project canvas document');
            }
            for (const ancestorId of path) attached.add(ancestorId);
        }
    }
}

function placeAssets(assets: CanvasAsset[], placements: Placement[] = []) {
    if (placements.length === 0) return assets;
    const positions = new Map(placements.map(item => [item.id, item]));
    if (positions.size !== placements.length) throw new Error('A canvas image was positioned more than once');
    const placed = assets.map(asset => {
        const position = positions.get(asset.id);
        positions.delete(asset.id);
        return position && (position.x !== asset.x || position.y !== asset.y) ? { ...asset, ...position } : asset;
    });
    if (positions.size) throw new Error('Cannot position an image from another canvas');
    return placed.every((asset, index) => asset === assets[index]) ? assets : placed;
}

function withMetadata(canvas: GoalProjectCanvas, assets: CanvasAsset[], categories: ReadonlyMap<string, GoalProjectCanvasCategory>) {
    validateMetadata(assets, categories);
    const previousCategories = canvas.categories ?? [];
    const nextCategories = Array.from(categories.values());
    if (nextCategories.length === previousCategories.length && nextCategories.every((category, index) => category === previousCategories[index]) &&
        assets.length === canvas.assets.length && assets.every((asset, index) => asset === canvas.assets[index])) return canvas;
    return { ...canvas, assets, categories: nextCategories.length ? nextCategories : undefined };
}

function applyChanges(canvas: GoalProjectCanvas, changes: GoalProjectCanvasChange[]) {
    const categories = new Map((canvas.categories ?? []).map(category => [category.id, category]));
    const assets = new Map(canvas.assets.map(asset => [asset.id, asset]));
    for (const change of changes) {
        if (change.type === 'upsert-category') {
            if (categories.get(change.id)?.name !== change.name) categories.set(change.id, { id: change.id, name: change.name });
            continue;
        }
        if (change.type === 'delete-category') {
            if (categories.delete(change.id)) {
                for (const asset of assets.values()) {
                    if (asset.categoryId === change.id) assets.set(asset.id, { ...asset, categoryId: undefined });
                }
            }
            continue;
        }
        const asset = assets.get(change.assetId);
        if (!asset) throw new Error('Canvas image is unavailable in this project');
        if (change.type === 'remove-asset') {
            assets.delete(asset.id);
            continue;
        }
        const name = change.name ?? asset.name;
        const categoryId = change.categoryId === undefined ? asset.categoryId : change.categoryId ?? undefined;
        const x = change.x ?? asset.x;
        const y = change.y ?? asset.y;
        if (name !== asset.name || categoryId !== asset.categoryId || x !== asset.x || y !== asset.y) {
            assets.set(asset.id, { ...asset, name, categoryId, x, y });
        }
    }
    return withMetadata(canvas, Array.from(assets.values()), categories);
}

function mergeBundle(canvas: GoalProjectCanvas, bundle: GoalProjectCanvasBundle): GoalProjectCanvas {
    const categories = new Map((canvas.categories ?? []).map(category => [category.id, category]));
    const assets = new Map(canvas.assets.map(asset => [asset.id, asset]));
    if (new Set(bundle.assets.map(asset => asset.id)).size !== bundle.assets.length ||
        new Set(bundle.categories.map(category => category.id)).size !== bundle.categories.length) {
        throw new Error('Canvas bundle contains duplicate IDs');
    }
    for (const category of bundle.categories) {
        const existing = categories.get(category.id);
        if (existing && existing.name !== category.name) throw new Error('Canvas bundle category ID is already in use');
        if (!existing) categories.set(category.id, category);
    }
    for (const asset of bundle.assets) {
        if (asset.id !== 'asset-' + asset.versionId) throw new Error('Canvas bundle image version does not match its ID');
        const existing = assets.get(asset.id);
        if (existing && (existing.mimeType !== asset.mimeType || existing.size !== asset.size)) {
            throw new Error('Canvas bundle image does not match the existing original');
        }
        if (!existing || existing.name !== asset.name || existing.categoryId !== asset.categoryId || existing.x !== asset.x || existing.y !== asset.y) {
            assets.set(asset.id, existing?.preview ? { ...asset, preview: existing.preview } : asset);
        }
    }
    const next = withMetadata(canvas, Array.from(assets.values()), categories);
    if (bundle.document === undefined || bundle.document === canvas.scene?.document) return next;
    return { ...next, scene: { document: bundle.document, revision: (canvas.scene?.revision ?? 0) + 1 } };
}

async function readBitmap(store: ProjectStore, path: string, bitmap: Bitmap) {
    const file = await openAuthorizedFile(store.directory, path, GOAL_CANVAS_LIMITS.assetBytes);
    try {
        if (file.actual !== path || file.info.size !== bitmap.size) throw new Error('Canvas bundle image bytes changed');
        const bytes = Buffer.alloc(bitmap.size);
        const { bytesRead } = await file.handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length || sha256(bytes) !== bitmap.versionId || detectCodexImage(bytes)?.mime !== bitmap.mimeType) {
            throw new Error('Canvas bundle image bytes changed');
        }
        return bytes;
    } finally {
        await file.handle.close();
    }
}

async function bundleDirectory(store: ProjectStore, bundleId: string) {
    const root = await privateDirectory(join(store.directory, BUNDLE_DIRECTORY));
    const directory = join(root, bundleId);
    const siblings = await readdir(root, { withFileTypes: true });
    let hasCurrent = false;
    let active = 0;
    for (const sibling of siblings) {
        if (!sibling.isDirectory() || !/^[a-f0-9-]{36}$/i.test(sibling.name)) continue;
        if (sibling.name === bundleId) { hasCurrent = true; continue; }
        const path = join(root, sibling.name);
        const info = await lstat(path);
        if (Date.now() - info.mtimeMs < BUNDLE_LIFETIME_MS) active++;
        else if (await realpath(path) === path) await rm(path, { recursive: true, force: true });
    }
    if (!hasCurrent && active >= MAX_STAGED_BUNDLES_PER_PROJECT) throw new Error('Too many active canvas bundle uploads');
    return privateDirectory(directory);
}

function decodeChunk(base64: string, byteLimit = GOAL_CANVAS_LIMITS.uploadChunkBytes) {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0 || bytes.length > byteLimit || bytes.toString('base64') !== base64)
        throw new Error('Invalid canvas image data');
    return bytes;
}

/** Inspect browser JPEG headers without decoding user-supplied image data on the daemon. */
function isPreviewJpeg(bytes: Buffer): boolean {
    if (detectCodexImage(bytes)?.mime !== 'image/jpeg' || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
    let offset = 2;
    let hasSize = false;
    const end = bytes.length - 2;
    while (offset + 4 <= end) {
        if (bytes[offset++] !== 0xff) return false;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (offset + 2 > end) return false;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > end) return false;
        if (marker >= 0xc0 && marker <= 0xc2) {
            if (length < 8) return false;
            const height = bytes.readUInt16BE(offset + 3);
            const width = bytes.readUInt16BE(offset + 5);
            if (height === 0 || width === 0 || Math.max(width, height) > GOAL_CANVAS_LIMITS.previewMaxSide) return false;
            hasSize = true;
        } else if (marker === 0xda) {
            return hasSize && length >= 8 && offset + length < end;
        }
        offset += length;
    }
    return false;
}

function requireAsset(canvas: GoalProjectCanvas, assetId: string, versionId: string) {
    const asset = canvas.assets.find(asset => asset.id === assetId && asset.versionId === versionId);
    if (!asset) throw new Error('Canvas image version is unavailable in this project');
    return asset;
}

async function readPreview(store: ProjectStore, asset: CanvasAsset) {
    const preview = asset.preview;
    if (!preview) throw new Error('Canvas image preview is unavailable');
    const path = join(store.directory, 'previews', asset.versionId);
    const source = await openAuthorizedFile(store.directory, path, GOAL_CANVAS_LIMITS.previewBytes);
    try {
        if (source.actual !== path || source.info.size !== preview.size) throw new Error('Canvas image preview bytes changed');
        const bytes = Buffer.alloc(preview.size);
        const { bytesRead } = await source.handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length || sha256(bytes) !== preview.versionId || !isPreviewJpeg(bytes)) {
            throw new Error('Canvas image preview bytes changed');
        }
        return bytes;
    } finally {
        await source.handle.close();
    }
}

function firstOpenPosition(assets: GoalProjectCanvas['assets']) {
    for (let slot = 0; ; slot++) {
        const x = 32 + 232 * (slot % 4);
        const y = 32 + 200 * Math.floor(slot / 4);
        if (assets.every(asset => Math.abs(asset.x - x) >= 232 || Math.abs(asset.y - y) >= 200)) return { x, y };
    }
}

export function createProjectCanvasService(storageDirectory: string, resolveProject: (projectPath: string) => Promise<string>, changed: (change?: GoalProjectCanvasChangeNotice) => void | Promise<void>) {
    const uploads = new Map<string, Upload>();
    const completedUploads = new Map<string, CompletedUpload>();
    const bundleUploads = new Map<string, StagedUpload>();

    const projectStore = async (projectPath: string): Promise<ProjectStore> => {
        const project = await resolveProject(projectPath);
        await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
        const storageRoot = await realpath(storageDirectory);
        const canvasRoot = await privateDirectory(join(storageRoot, 'project-canvases'));
        const id = 'canvas-' + sha256(project);
        const directory = await privateDirectory(join(canvasRoot, id));
        return { id, directory, manifest: join(directory, 'canvas.json') };
    };

    // A manifest is atomically replaced. Serialize readers with writers so
    // the authorized inode check never mistakes our own replacement for a race.
    const orderManifestOperation = async <T>(store: ProjectStore, operation: () => Promise<T>): Promise<T> => {
        const pending = (manifestOperations.get(store.manifest) ?? Promise.resolve()).catch(() => {}).then(operation);
        manifestOperations.set(store.manifest, pending);
        try { return await pending; }
        finally { if (manifestOperations.get(store.manifest) === pending) manifestOperations.delete(store.manifest); }
    };

    const readSnapshot = async (store: ProjectStore) => orderManifestOperation(store, () => readCanvas(store));
    const mutate = async (store: ProjectStore, update: () => Promise<GoalProjectCanvas>): Promise<CanvasResult> =>
        ({ success: true, canvas: await orderManifestOperation(store, update) });

    const commit = async (store: ProjectStore, canvas: GoalProjectCanvas, notice?: GoalProjectCanvasChangeNotice | false) => {
        const document = JSON.stringify(canvas);
        if (Buffer.byteLength(document, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Canvas project manifest is too large');
        await atomicWrite(store.manifest, document);
        // The change event can be delivered after the commit. A transient notification
        // failure must not report a successful disk commit as a failed write.
        const change = notice === false ? undefined : notice ?? {
            kind: 'content' as const, canvasId: canvas.id, baseRevision: canvas.revision - 1, revision: canvas.revision,
        };
        await Promise.resolve().then(() => changed(change)).catch(() => {});
        return canvas;
    };

    const importImage = (store: ProjectStore, input: ImageInput, bytes: Buffer) => {
        if (detectCodexImage(bytes)?.mime !== input.mimeType) throw new Error('Image data does not match a supported image format');
        const versionId = sha256(bytes);
        const id = 'asset-' + versionId;
        return mutate(store, async () => {
            const canvas = await readCanvas(store);
            if (canvas.assets.some(asset => asset.id === id)) return canvas;
            if (canvas.assets.length >= GOAL_CANVAS_LIMITS.assets) throw new Error('Canvas image limit reached');
            const assets = await privateDirectory(join(store.directory, 'assets'));
            await atomicWrite(join(assets, versionId), bytes);
            const asset = { id, versionId, name: input.name, mimeType: input.mimeType, size: bytes.length, ...firstOpenPosition(canvas.assets) };
            return commit(store, { ...canvas, revision: canvas.revision + 1, assets: [...canvas.assets, asset] });
        });
    };

    const removeExpiredUploads = (now: number) => {
        for (const [key, upload] of uploads) if (!upload.completing && now - upload.updatedAt >= UPLOAD_LIFETIME_MS) uploads.delete(key);
        for (const [key, upload] of completedUploads) if (now - upload.updatedAt >= UPLOAD_LIFETIME_MS) completedUploads.delete(key);
        for (const [key, upload] of bundleUploads) if (now - upload.updatedAt >= UPLOAD_LIFETIME_MS) bundleUploads.delete(key);
    };

    const discardBundle = async (store: ProjectStore, bundleId: string) => {
        const prefix = `${store.id}:${bundleId}:`;
        for (const key of bundleUploads.keys()) if (key.startsWith(prefix)) bundleUploads.delete(key);
        const stage = join(store.directory, BUNDLE_DIRECTORY, bundleId);
        if (await realpath(stage).then(path => path === stage, () => false)) {
            await rm(stage, { recursive: true, force: true }).catch(() => {});
        }
    };

    const service = {
        get: async (input: unknown): Promise<CanvasResult> => {
            const { projectPath } = GoalProjectCanvasRequests.goalProjectCanvasGet.parse(input);
            return { success: true, canvas: await readSnapshot(await projectStore(projectPath)) };
        },
        import: async (input: unknown): Promise<CanvasResult | { success: true; nextOffset: number }> => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasImport.parse(input);
            const bytes = decodeChunk(data.base64);
            const store = await projectStore(data.projectPath);
            if (!('uploadId' in data)) return importImage(store, data, bytes);
            if (data.offset + bytes.length > data.totalSize) throw new Error('Canvas image chunk exceeds the declared size');

            const now = Date.now();
            const key = store.id + ':' + data.uploadId;
            removeExpiredUploads(now);
            const previous = completedUploads.get(key);
            const sameUpload = (record: UploadDetails) => record.name === data.name && record.mimeType === data.mimeType && record.totalSize === data.totalSize;
            if (previous) {
                if (!sameUpload(previous) || previous.offset !== data.offset || previous.hash !== sha256(bytes)) throw new Error('Canvas image upload is already complete');
                return { success: true, canvas: await readSnapshot(store) };
            }

            let upload = uploads.get(key);
            if (!upload) {
                if (data.offset !== 0) throw new Error('Start the canvas image upload at offset zero');
                if (uploads.size + bundleUploads.size >= MAX_OPEN_UPLOADS) throw new Error('Too many active canvas image uploads');
                upload = { name: data.name, mimeType: data.mimeType, totalSize: data.totalSize, bytes: Buffer.alloc(data.totalSize), nextOffset: 0, updatedAt: now };
                uploads.set(key, upload);
            }
            if (!sameUpload(upload) || data.offset > upload.nextOffset) throw new Error('Canvas image chunks are out of order');
            if (data.offset < upload.nextOffset) {
                const end = data.offset + bytes.length;
                if (end > upload.nextOffset || !upload.bytes.subarray(data.offset, end).equals(bytes)) throw new Error('Canvas image chunk conflicts with an earlier chunk');
                return upload.completing ?? { success: true, nextOffset: upload.nextOffset };
            }
            bytes.copy(upload.bytes, data.offset);
            upload.nextOffset += bytes.length;
            upload.updatedAt = now;
            if (upload.nextOffset < data.totalSize) return { success: true, nextOffset: upload.nextOffset };

            try {
                upload.completing = importImage(store, data, upload.bytes);
                const result = await upload.completing;
                if (completedUploads.size >= MAX_COMPLETED_UPLOADS) {
                    const oldest = completedUploads.keys().next().value;
                    if (oldest) completedUploads.delete(oldest);
                }
                completedUploads.set(key, { name: data.name, mimeType: data.mimeType, totalSize: data.totalSize, offset: data.offset, hash: sha256(bytes), updatedAt: Date.now() });
                return result;
            } finally {
                uploads.delete(key);
            }
        },
        asset: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasAsset.parse(input);
            const store = await projectStore(data.projectPath);
            const canvas = await readSnapshot(store);
            const asset = requireAsset(canvas, data.assetId, data.versionId);
            if (data.offset >= asset.size) throw new Error('Invalid canvas image offset');
            const path = join(await privateDirectory(join(store.directory, 'assets')), asset.versionId);
            const source = await openAuthorizedFile(store.directory, path, GOAL_CANVAS_LIMITS.assetBytes);
            try {
                if (source.actual !== path || source.info.size !== asset.size) throw new Error('Canvas image bytes changed');
                const bytes = Buffer.alloc(Math.min(GOAL_CANVAS_LIMITS.downloadChunkBytes, asset.size - data.offset));
                const { bytesRead } = await source.handle.read(bytes, 0, bytes.length, data.offset);
                if (bytesRead !== bytes.length) throw new Error('Canvas image bytes changed during read');
                const nextOffset = data.offset + bytesRead;
                return { success: true as const, base64: bytes.toString('base64'), size: asset.size, nextOffset: nextOffset < asset.size ? nextOffset : null };
            } finally {
                await source.handle.close();
            }
        },
        preview: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasPreview.parse(input);
            const store = await projectStore(data.projectPath);
            return orderManifestOperation(store, async () => {
                const canvas = await readCanvas(store);
                const bytes = await readPreview(store, requireAsset(canvas, data.assetId, data.versionId));
                return { success: true as const, base64: bytes.toString('base64'), size: bytes.length };
            });
        },
        putPreview: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasPutPreview.parse(input);
            const bytes = decodeChunk(data.base64, GOAL_CANVAS_LIMITS.previewBytes);
            if (!isPreviewJpeg(bytes)) throw new Error('Canvas image preview must be a small JPEG');
            const store = await projectStore(data.projectPath);
            return mutate(store, async () => {
                const canvas = await readCanvas(store);
                const asset = requireAsset(canvas, data.assetId, data.versionId);
                if (asset.preview && await readPreview(store, asset).then(() => true, () => false)) return canvas;

                const directory = await privateDirectory(join(store.directory, 'previews'));
                await atomicWrite(join(directory, asset.versionId), bytes);
                const preview = { size: bytes.length, versionId: sha256(bytes) };
                const assets = canvas.assets.map(item => item === asset ? { ...item, preview } : item);
                // The legacy endpoint retains its full response and broad notification.
                return commit(store, { ...canvas, revision: canvas.revision + 1, assets }, false);
            });
        },
        putPreviewReceipt: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasPutPreviewReceipt.parse(input);
            const bytes = decodeChunk(data.base64, GOAL_CANVAS_LIMITS.previewBytes);
            if (!isPreviewJpeg(bytes)) throw new Error('Canvas image preview must be a small JPEG');
            const store = await projectStore(data.projectPath);
            return orderManifestOperation(store, async () => {
                const canvas = await readCanvas(store);
                const asset = requireAsset(canvas, data.assetId, data.versionId);
                const receipt = (savedAsset: CanvasAsset, savedRevision: number) => ({
                    success: true as const, canvasId: canvas.id, baseRevision: canvas.revision,
                    revision: savedRevision, asset: savedAsset,
                });
                if (asset.preview && await readPreview(store, asset).then(() => true, () => false)) return receipt(asset, canvas.revision);
                const directory = await privateDirectory(join(store.directory, 'previews'));
                await atomicWrite(join(directory, asset.versionId), bytes);
                const savedAsset = { ...asset, preview: { size: bytes.length, versionId: sha256(bytes) } };
                const revision = canvas.revision + 1;
                const result = receipt(savedAsset, revision);
                const { success: _success, ...delta } = result;
                await commit(store, { ...canvas, revision, assets: canvas.assets.map(item => item === asset ? savedAsset : item) },
                    { kind: 'preview', ...delta });
                return result;
            });
        },
        layout: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasLayout.parse(input);
            const store = await projectStore(data.projectPath);
            return mutate(store, async () => {
                const canvas = await readCanvas(store);
                if (data.revision !== canvas.revision) throw new Error(staleProject);
                const assets = placeAssets(canvas.assets, data.placements);
                if (assets === canvas.assets) return canvas;
                return commit(store, { ...canvas, revision: canvas.revision + 1, assets });
            });
        },
        mutate: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasMutate.parse(input);
            const store = await projectStore(data.projectPath);
            return mutate(store, async () => {
                const canvas = await readCanvas(store);
                if (data.revision !== canvas.revision) throw new Error(staleProject);
                const next = applyChanges(canvas, data.changes);
                if (next === canvas) return canvas;
                return commit(store, { ...next, revision: canvas.revision + 1 });
            });
        },
        saveScene: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasSaveScene.parse(input);
            validateSceneDocument(data.document);
            const store = await projectStore(data.projectPath);
            return mutate(store, async () => {
                const canvas = await readCanvas(store);
                const revision = canvas.scene?.revision ?? 0;
                if (data.revision !== revision) throw new Error('Canvas scene was modified. Reload before saving.');
                const assets = placeAssets(canvas.assets, data.placements);
                if (canvas.scene?.document === data.document && assets === canvas.assets) return canvas;
                return commit(store, {
                    ...canvas, assets, revision: canvas.revision + 1,
                    scene: { revision: revision + 1, document: data.document },
                });
            });
        },
        stageBundleAsset: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasStageBundleAsset.parse(input);
            const bytes = decodeChunk(data.base64);
            const end = data.offset + bytes.length;
            if (end > data.totalSize) throw new Error('Canvas bundle image chunk exceeds the declared size');
            const store = await projectStore(data.projectPath);
            return orderManifestOperation(store, async () => {
                const now = Date.now();
                removeExpiredUploads(now);
                const directory = await bundleDirectory(store, data.bundleId);
                const destination = join(directory, data.versionId);
                const staged = await readBitmap(store, destination, { ...data, size: data.totalSize }).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                    throw error;
                });
                if (staged) {
                    if (!staged.subarray(data.offset, end).equals(bytes)) throw new Error('Canvas bundle image chunk conflicts with staged bytes');
                    return { success: true as const, nextOffset: end === data.totalSize ? null : end };
                }
                const key = `${store.id}:${data.bundleId}:${data.versionId}`;
                let upload = bundleUploads.get(key);
                if (!upload) {
                    if (data.offset !== 0) throw new Error('Start the canvas bundle image upload at offset zero');
                    if (uploads.size + bundleUploads.size >= MAX_OPEN_UPLOADS) throw new Error('Too many active canvas image uploads');
                    upload = {
                        mimeType: data.mimeType, totalSize: data.totalSize, bytes: Buffer.alloc(data.totalSize), nextOffset: 0, updatedAt: now,
                    };
                    bundleUploads.set(key, upload);
                }
                if (upload.mimeType !== data.mimeType || upload.totalSize !== data.totalSize || data.offset > upload.nextOffset) {
                    throw new Error('Canvas bundle image chunks are out of order');
                }
                if (data.offset < upload.nextOffset) {
                    if (end > upload.nextOffset || !upload.bytes.subarray(data.offset, end).equals(bytes)) {
                        throw new Error('Canvas bundle image chunk conflicts with an earlier chunk');
                    }
                    return { success: true as const, nextOffset: upload.nextOffset };
                }
                bytes.copy(upload.bytes, data.offset);
                upload.nextOffset = end;
                upload.updatedAt = now;
                if (end < data.totalSize) return { success: true as const, nextOffset: end };
                try {
                    if (sha256(upload.bytes) !== data.versionId || detectCodexImage(upload.bytes)?.mime !== data.mimeType) {
                        throw new Error('Canvas bundle image fingerprint or image format does not match');
                    }
                    if ((await readdir(directory)).filter(name => /^[a-f0-9]{64}$/.test(name)).length >= GOAL_CANVAS_LIMITS.assets) {
                        throw new Error('Canvas bundle image limit reached');
                    }
                    await atomicWrite(destination, upload.bytes);
                    return { success: true as const, nextOffset: null };
                } finally {
                    bundleUploads.delete(key);
                }
            });
        },
        commitBundle: async (input: unknown) => {
            const data = GoalProjectCanvasRequests.goalProjectCanvasCommitBundle.parse(input);
            if (data.bundle.document !== undefined) validateSceneDocument(data.bundle.document);
            const store = await projectStore(data.projectPath);
            return mutate(store, async () => {
                const canvas = await readCanvas(store);
                const next = mergeBundle(canvas, data.bundle);
                if (next === canvas) {
                    await discardBundle(store, data.bundleId);
                    return canvas;
                }
                if (data.revision !== canvas.revision) throw new Error(staleProject);
                const directory = await privateDirectory(join(store.directory, 'assets'));
                const stage = join(store.directory, BUNDLE_DIRECTORY, data.bundleId);
                const installed: string[] = [];
                let saved: GoalProjectCanvas;
                try {
                    for (const asset of data.bundle.assets) {
                        const path = join(directory, asset.versionId);
                        const hasOriginal = await readBitmap(store, path, asset).then(() => true, error => {
                            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                            throw error;
                        });
                        if (hasOriginal) continue;
                        const bytes = await readBitmap(store, join(stage, asset.versionId), asset).catch(error => {
                            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Canvas bundle image has not been fully staged');
                            throw error;
                        });
                        await atomicWrite(path, bytes);
                        installed.push(path);
                    }
                    saved = await commit(store, { ...next, revision: canvas.revision + 1 });
                } catch (error) {
                    await Promise.allSettled(installed.map(path => unlink(path)));
                    throw error;
                }
                await discardBundle(store, data.bundleId);
                return saved;
            });
        },
        dispose() { uploads.clear(); completedUploads.clear(); bundleUploads.clear(); },
    };
    return service;
}
