import { GoalProjectCanvasBundleSchema, type GoalProjectCanvas, type GoalProjectCanvasBundle } from './goalProjectCanvas';

export const GOAL_CANVAS_PACKAGE_EXTENSION = '.pawscanvas';
export const GOAL_CANVAS_PACKAGE_MAX_BYTES = 128 * 1024 * 1024;
const identifier = new TextEncoder().encode('PAWSCAN1');
const prefixLength = identifier.length + 4;
const maxMetadataBytes = 2 * 1024 * 1024;

export function goalCanvasBundleFromSnapshot(canvas: GoalProjectCanvas, assetIds?: readonly string[]): GoalProjectCanvasBundle {
    const selected = assetIds && new Set(assetIds);
    const assets = canvas.assets.filter(asset => !selected || selected.has(asset.id)).map(({ preview: _preview, ...asset }) => asset);
    if (selected && assets.length !== selected.size) throw new Error('Selected canvas assets are no longer available');
    return {
        categories: (canvas.categories ?? []).filter(category => !selected || assets.some(asset => asset.categoryId === category.id)),
        assets,
        ...(!selected && canvas.scene ? { document: canvas.scene.document } : {}),
    };
}

export function goalCanvasPackageHeader(bundle: GoalProjectCanvasBundle): Uint8Array<ArrayBuffer> {
    const portable = GoalProjectCanvasBundleSchema.parse(bundle);
    const json = new TextEncoder().encode(JSON.stringify(portable));
    if (json.length > maxMetadataBytes || prefixLength + json.length + portable.assets.reduce((bytes, asset) => bytes + asset.size, 0) > GOAL_CANVAS_PACKAGE_MAX_BYTES) {
        throw new Error('Canvas package exceeds its size limit');
    }
    const header = new Uint8Array(prefixLength + json.length);
    header.set(identifier);
    new DataView(header.buffer).setUint32(identifier.length, json.length);
    header.set(json, prefixLength);
    return header;
}

export async function readGoalCanvasPackage(size: number, read: (start: number, end: number) => Promise<Uint8Array>) {
    if (size < prefixLength || size > GOAL_CANVAS_PACKAGE_MAX_BYTES) throw new Error('Invalid canvas package size');
    const prefix = await read(0, prefixLength);
    if (prefix.length !== prefixLength || !identifier.every((byte, index) => prefix[index] === byte)) throw new Error('Unsupported canvas package format');
    const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(identifier.length);
    const filesStart = prefixLength + length;
    if (length < 1 || length > maxMetadataBytes || filesStart > size) throw new Error('Invalid canvas package metadata');
    const json = await read(prefixLength, filesStart);
    if (json.length !== length) throw new Error('Incomplete canvas package metadata');
    const bundle = GoalProjectCanvasBundleSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)));
    let start = filesStart;
    const files = bundle.assets.map(asset => {
        const range = { asset, start, end: start + asset.size };
        start = range.end;
        return range;
    });
    if (start !== size) throw new Error('Canvas package files do not match the metadata');
    return { bundle, files };
}

export function prepareGoalCanvasBundleImport(canvas: GoalProjectCanvas, bundle: GoalProjectCanvasBundle, createCategoryId: () => string): GoalProjectCanvasBundle {
    const known = [...(canvas.categories ?? [])];
    const mapping = new Map<string, string>();
    const categories = [];
    for (const category of bundle.categories) {
        const sameId = known.find(item => item.id === category.id);
        const equivalent = sameId?.name === category.name ? sameId : sameId && known.find(item => item.name === category.name);
        const id = equivalent?.id ?? (sameId ? createCategoryId() : category.id);
        mapping.set(category.id, id);
        if (equivalent) continue;
        const imported = { ...category, id };
        categories.push(imported);
        known.push(imported);
    }
    const existing = new Map(canvas.assets.map(asset => [asset.id, asset]));
    const assets = bundle.assets.map(asset => {
        const current = existing.get(asset.id);
        if (current) {
            // Preserve edits and classification in a populated board on reimport.
            const { preview: _preview, ...metadata } = current;
            return metadata;
        }
        return asset.categoryId ? { ...asset, categoryId: mapping.get(asset.categoryId) ?? asset.categoryId } : asset;
    });
    return {
        categories, assets,
        ...(canvas.assets.length === 0 && !canvas.scene && bundle.document ? { document: bundle.document } : {}),
    };
}
