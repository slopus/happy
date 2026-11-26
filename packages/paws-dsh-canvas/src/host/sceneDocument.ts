import type { TLRecord, TLStore, TLStoreSnapshot } from 'tldraw';
import { isProjectCanvasDocument, PROJECT_CANVAS_SCENE_DOCUMENT_VERSION } from '../protocol';

export const managedAssetKey = /^asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
const managedBitmapId = /^asset:ig-asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
const managedShapeId = /^shape:ig-asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
const inlineRaster = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const mediaAttributes = new Set(['href', 'src', 'srcset', 'poster', 'url']);

type SceneDocument = TLStoreSnapshot & {
    version: typeof PROJECT_CANVAS_SCENE_DOCUMENT_VERSION;
    removed: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRichText(value: unknown, depth = 0): unknown {
    if (depth > 64) throw new Error('Project canvas text is nested too deeply');
    if (Array.isArray(value)) return value.map(item => safeRichText(item, depth + 1));
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, mediaAttributes.has(key.toLowerCase()) ? '' : safeRichText(item, depth + 1),
    ]));
}

// Project bitmaps live in the manifest. That includes source bytes and all
// display resolution state. The editor can reattach either rendition by ID.
function withoutNetworkSources(record: TLRecord): TLRecord {
    if (record.typeName === 'user') return { ...record, imageUrl: '' };
    if (record.typeName === 'asset') {
        if (record.type === 'image') {
            const managed = managedBitmapId.test(record.id);
            const src = record.props.src;
            const { pawsDisplayQuality: _quality, ...meta } = record.meta;
            return { ...record, meta, props: {
                ...record.props, src: !managed && src && inlineRaster.test(src) ? src : null,
            } };
        }
        if (record.type === 'bookmark') {
            return { ...record, props: { ...record.props, src: null, image: '', favicon: '' } };
        }
        if (record.type === 'video') return { ...record, props: { ...record.props, src: null } };
    }
    if (record.typeName === 'shape') {
        const props = { ...record.props };
        if ('url' in props) props.url = '';
        if ('richText' in props) props.richText = safeRichText(props.richText) as typeof props.richText;
        return { ...record, props } as TLRecord;
    }
    return record;
}

export function writeSceneDocument(store: TLStore, removed: ReadonlySet<string>): string | undefined {
    const snapshot = store.getStoreSnapshot();
    const document: SceneDocument = {
        version: PROJECT_CANVAS_SCENE_DOCUMENT_VERSION,
        schema: snapshot.schema,
        store: Object.fromEntries(Object.entries(snapshot.store)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, record]) => [id, withoutNetworkSources(record)])) as TLStoreSnapshot['store'],
        removed: [...removed].sort(),
    };
    const serialized = JSON.stringify(document);
    return isProjectCanvasDocument(serialized) ? serialized : undefined;
}

function readSnapshot(document: string, store: TLStore): SceneDocument {
    const value: unknown = JSON.parse(document);
    if (!isObject(value) || value.version !== PROJECT_CANVAS_SCENE_DOCUMENT_VERSION
        || !Array.isArray(value.removed) || value.removed.length > 160
        || !value.removed.every(key => typeof key === 'string' && managedAssetKey.test(key))
        || new Set(value.removed).size !== value.removed.length
        || !isObject(value.schema) || value.schema.schemaVersion !== 2
        || !isObject(value.schema.sequences) || !isObject(value.store)) {
        throw new Error('Invalid project canvas document');
    }
    const knownSequences = store.schema.serialize().sequences;
    for (const [sequence, version] of Object.entries(value.schema.sequences)) {
        if (!Object.hasOwn(knownSequences, sequence) || typeof version !== 'number' || !Number.isInteger(version)
            || version < 0 || version > knownSequences[sequence]) throw new Error('Unsupported project canvas schema');
    }
    // The SDK migrates trusted schema sequences. Check scope and record IDs
    // before migrations, then validate migrated records before touching the editor.
    for (const [id, record] of Object.entries(value.store)) {
        if (!isObject(record) || record.id !== id || id.length > 1024 || typeof record.typeName !== 'string'
            || !id.startsWith(record.typeName + ':') || !(store.scopedTypes.document as ReadonlySet<string>).has(record.typeName)) {
            throw new Error('Invalid project canvas record');
        }
    }
    const snapshot = store.migrateSnapshot(value as unknown as TLStoreSnapshot);
    let hasPage = false;
    let hasDocument = false;
    const records = new Map<string, TLRecord>(Object.entries(snapshot.store));
    for (const [id, record] of records) {
        const recordType = store.schema.types[record.typeName];
        if (!recordType || recordType.scope !== 'document' || record.id !== id) throw new Error('Invalid project canvas record');
        recordType.validate(record);
        const sanitized = withoutNetworkSources(record);
        if (JSON.stringify(sanitized) !== JSON.stringify(record)) throw new Error('Unsafe resource in project canvas document');
        if (record.typeName === 'document') hasDocument = true;
        if (record.typeName === 'page') hasPage = true;
        if (record.typeName === 'shape') {
            const canonical = managedShapeId.test(id);
            const key = record.meta.galleryId;
            if (canonical || (typeof key === 'string' && managedAssetKey.test(key))) {
                if (record.type !== 'image' || typeof key !== 'string' || !managedAssetKey.test(key)
                    || record.props.assetId !== `asset:ig-${key}` || (canonical && id !== `shape:ig-${key}`)) {
                    throw new Error('Invalid project canvas image reference');
                }
            }
        }
        if (record.typeName === 'binding') {
            if (records.get(record.fromId)?.typeName !== 'shape' || records.get(record.toId)?.typeName !== 'shape') {
                throw new Error('Missing shape in project canvas binding');
            }
        }
    }
    if (!hasPage || !hasDocument) throw new Error('Project canvas is missing its document or pages');
    const attached = new Set<string>();
    for (const record of records.values()) {
        if (record.typeName !== 'shape' || attached.has(record.id)) continue;
        const path = new Set<string>();
        let ancestor: TLRecord | undefined = record;
        while (ancestor?.typeName === 'shape' && !attached.has(ancestor.id)) {
            if (path.has(ancestor.id) || path.size > 128) throw new Error('Invalid project canvas shape ancestry');
            path.add(ancestor.id);
            ancestor = records.get(ancestor.parentId);
        }
        if (!ancestor || (ancestor.typeName !== 'page' && !attached.has(ancestor.id))) {
            throw new Error('Missing parent in project canvas document');
        }
        for (const id of path) attached.add(id);
    }
    return { ...snapshot, version: PROJECT_CANVAS_SCENE_DOCUMENT_VERSION, removed: value.removed };
}

export function readSceneDocument(document: string, store: TLStore): SceneDocument | undefined {
    if (!isProjectCanvasDocument(document)) return undefined;
    try {
        return readSnapshot(document, store);
    } catch {
        return undefined;
    }
}
