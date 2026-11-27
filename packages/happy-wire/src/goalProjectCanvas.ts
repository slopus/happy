import { z } from 'zod';

export const GOAL_CANVAS_LIMITS = {
    assets: 160,
    categories: 160,
    sceneBytes: 384 * 1024,
    assetBytes: 12 * 1024 * 1024,
    previewBytes: 64 * 1024,
    previewMaxSide: 1024,
    uploadChunkBytes: 384 * 1024,
    downloadChunkBytes: 64 * 1024,
} as const;

export const GoalCanvasImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const versionId = z.string().regex(/^[a-f0-9]{64}$/);
const assetId = z.string().regex(/^asset-[a-f0-9]{64}$/);
const coordinate = z.number().min(-1_000_000).max(1_000_000);
const name = z.string().trim().min(1).max(160).refine(value => !/[\\/\x00-\x1f\x7f]/.test(value));
const categoryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
const categoryName = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const assetSize = z.number().int().positive().max(GOAL_CANVAS_LIMITS.assetBytes);
const sceneDocument = z.string().min(2).max(GOAL_CANVAS_LIMITS.sceneBytes);
const previewSize = z.number().int().positive().max(GOAL_CANVAS_LIMITS.previewBytes);
const previewBase64 = z.string().min(4).max(Math.ceil(GOAL_CANVAS_LIMITS.previewBytes / 3) * 4);
const chunkBase64 = z.string().min(4).max(Math.ceil(GOAL_CANVAS_LIMITS.uploadChunkBytes / 3) * 4);

export const GoalCanvasPlacementSchema = z.object({ id: assetId, x: coordinate, y: coordinate }).strict();
export const GoalCanvasAssetSchema = GoalCanvasPlacementSchema.extend({
    versionId, name, mimeType: GoalCanvasImageMimeSchema,
    size: assetSize,
    categoryId: categoryId.optional(),
    preview: z.object({ size: previewSize, versionId }).strict().optional(),
});
export const GoalProjectCanvasCategorySchema = z.object({ id: categoryId, name: categoryName }).strict();
export const GoalProjectCanvasSceneSchema = z.object({ revision, document: sceneDocument }).strict();
const categories = z.array(GoalProjectCanvasCategorySchema).max(GOAL_CANVAS_LIMITS.categories);
const placements = z.array(GoalCanvasPlacementSchema).max(GOAL_CANVAS_LIMITS.assets);
export const GoalProjectCanvasSchema = z.object({
    id: z.string().regex(/^canvas-[a-f0-9]{64}$/),
    revision,
    assets: z.array(GoalCanvasAssetSchema).max(GOAL_CANVAS_LIMITS.assets),
    categories: categories.optional(),
    scene: GoalProjectCanvasSceneSchema.optional(),
}).strict();
export const GoalProjectCanvasChangeSchema = z.discriminatedUnion('type', [
    GoalProjectCanvasCategorySchema.extend({ type: z.literal('upsert-category') }),
    z.object({ type: z.literal('delete-category'), id: categoryId }).strict(),
    z.object({
        type: z.literal('update-asset'),
        assetId,
        name: name.optional(),
        categoryId: categoryId.nullable().optional(),
        x: coordinate.optional(),
        y: coordinate.optional(),
    }).strict(),
    z.object({ type: z.literal('remove-asset'), assetId }).strict(),
]);
export const GoalProjectCanvasBundleSchema = z.object({
    categories,
    assets: z.array(GoalCanvasAssetSchema.omit({ preview: true })).max(GOAL_CANVAS_LIMITS.assets),
    document: sceneDocument.optional(),
}).strict();
export type GoalProjectCanvas = z.infer<typeof GoalProjectCanvasSchema>;
export type GoalProjectCanvasCategory = z.infer<typeof GoalProjectCanvasCategorySchema>;
export type GoalProjectCanvasScene = z.infer<typeof GoalProjectCanvasSceneSchema>;
export type GoalProjectCanvasChange = z.infer<typeof GoalProjectCanvasChangeSchema>;
export type GoalProjectCanvasBundle = z.infer<typeof GoalProjectCanvasBundleSchema>;

export const GoalProjectCanvasPreviewReceiptSchema = z.object({
    success: z.literal(true),
    canvasId: GoalProjectCanvasSchema.shape.id,
    baseRevision: revision,
    revision,
    asset: GoalCanvasAssetSchema,
}).strict();
export type GoalProjectCanvasPreviewReceipt = z.infer<typeof GoalProjectCanvasPreviewReceiptSchema>;
export const GoalProjectCanvasChangeNoticeSchema = z.discriminatedUnion('kind', [
    GoalProjectCanvasPreviewReceiptSchema.omit({ success: true }).extend({ kind: z.literal('preview') }),
    z.object({ kind: z.literal('content'), canvasId: GoalProjectCanvasSchema.shape.id, baseRevision: revision, revision }).strict(),
]);
export type GoalProjectCanvasChangeNotice = z.infer<typeof GoalProjectCanvasChangeNoticeSchema>;

const project = z.object({ projectPath: z.string().min(1).max(8192) }).strict();
const asset = project.extend({ assetId, versionId });
const image = project.extend({
    name,
    mimeType: GoalCanvasImageMimeSchema,
    base64: chunkBase64,
});
const offset = z.number().int().nonnegative().max(GOAL_CANVAS_LIMITS.assetBytes);
export const GoalProjectCanvasRequests = {
    goalProjectCanvasGet: project,
    goalProjectCanvasImport: z.union([image, image.extend({
        uploadId: z.uuid(), offset, totalSize: assetSize,
    })]),
    goalProjectCanvasAsset: asset.extend({ offset }),
    goalProjectCanvasPreview: asset,
    goalProjectCanvasPutPreview: asset.extend({ base64: previewBase64 }),
    goalProjectCanvasPutPreviewReceipt: asset.extend({ base64: previewBase64 }),
    goalProjectCanvasLayout: project.extend({ revision, placements }),
    goalProjectCanvasMutate: project.extend({
        revision,
        changes: z.array(GoalProjectCanvasChangeSchema).min(1).max(GOAL_CANVAS_LIMITS.assets * 3),
    }),
    goalProjectCanvasSaveScene: project.extend({ revision, document: sceneDocument, placements: placements.optional() }),
    goalProjectCanvasStageBundleAsset: project.extend({
        bundleId: z.uuid(), versionId, mimeType: GoalCanvasImageMimeSchema, totalSize: assetSize, offset, base64: chunkBase64,
    }),
    goalProjectCanvasCommitBundle: project.extend({ revision, bundleId: z.uuid(), bundle: GoalProjectCanvasBundleSchema }),
} as const;

const canvasResponse = z.object({ success: z.literal(true), canvas: GoalProjectCanvasSchema }).strict();
const error = z.object({ success: z.literal(false), error: z.string() }).strict();
export const GoalProjectCanvasResponses = {
    goalProjectCanvasGet: z.union([canvasResponse, error]),
    goalProjectCanvasImport: z.union([canvasResponse, z.object({ success: z.literal(true), nextOffset: offset }).strict(), error]),
    goalProjectCanvasAsset: z.union([z.object({
        success: z.literal(true), base64: z.string(), size: assetSize, nextOffset: offset.nullable(),
    }).strict(), error]),
    goalProjectCanvasPreview: z.union([z.object({ success: z.literal(true), base64: previewBase64, size: previewSize }).strict(), error]),
    goalProjectCanvasPutPreview: z.union([canvasResponse, error]),
    goalProjectCanvasPutPreviewReceipt: z.union([GoalProjectCanvasPreviewReceiptSchema, error]),
    goalProjectCanvasLayout: z.union([canvasResponse, error]),
    goalProjectCanvasMutate: z.union([canvasResponse, error]),
    goalProjectCanvasSaveScene: z.union([canvasResponse, error]),
    goalProjectCanvasStageBundleAsset: z.union([z.object({ success: z.literal(true), nextOffset: offset.nullable() }).strict(), error]),
    goalProjectCanvasCommitBundle: z.union([canvasResponse, error]),
} as const;
