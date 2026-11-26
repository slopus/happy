import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
    GOAL_CANVAS_LIMITS, GOAL_CANVAS_PACKAGE_EXTENSION, GOAL_CANVAS_PACKAGE_MAX_BYTES,
    GoalProjectCanvasRequests, goalCanvasBundleFromSnapshot, goalCanvasPackageHeader,
    prepareGoalCanvasBundleImport, readGoalCanvasPackage, type GoalProjectCanvas,
} from '@slopus/happy-wire';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { createProjectCanvasService } from './projectCanvas';
import { openAuthorizedFile } from './authorizedFiles';
import { safePath } from './catalog';
import { detectCodexImage } from '../../codex/codexImageInput';

const filePath = z.string().min(1).max(8192);
const ids = z.array(z.string().regex(/^asset-[a-f0-9]{64}$/)).min(1).max(GOAL_CANVAS_LIMITS.assets);
const command = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list'), categoryId: z.string().max(120).nullable().optional() }).strict(),
    z.object({ action: z.literal('read-image'), assetId: ids.element, quality: z.enum(['preview', 'original']).default('preview') }).strict(),
    z.object({ action: z.literal('get-scene') }).strict(),
    GoalProjectCanvasRequests.goalProjectCanvasMutate.omit({ projectPath: true }).extend({ action: z.literal('change') }),
    GoalProjectCanvasRequests.goalProjectCanvasSaveScene.omit({ projectPath: true }).extend({ action: z.literal('save-scene') }),
    z.object({ action: z.literal('import-image'), path: filePath }).strict(),
    z.object({ action: z.literal('import-package'), path: filePath }).strict(),
    z.object({ action: z.literal('export-package'), path: filePath, assetIds: ids.optional() }).strict(),
]);

export const ProjectCanvasLocalRequest = z.union([
    z.object({ sessionId: z.string().min(1).max(256), command }).strict(),
    z.object({ projectPath: filePath, command }).strict(),
]);
export type ProjectCanvasLocalRequest = z.infer<typeof ProjectCanvasLocalRequest>;
type Command = z.infer<typeof command>;
type CanvasService = ReturnType<typeof createProjectCanvasService>;
type CanvasAsset = GoalProjectCanvas['assets'][number];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const canReadCanvas = (action: Command['action']) => action === 'list' || action === 'read-image' || action === 'get-scene';
export const canvasToolError = (reason: unknown): CallToolResult => ({
    isError: true, content: [{ type: 'text', text: reason instanceof Error ? reason.message.slice(0, 600) : 'Project canvas request failed' }],
});
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const metadata = (canvas: GoalProjectCanvas) => ({
    id: canvas.id, revision: canvas.revision, sceneRevision: canvas.scene?.revision ?? 0, categories: canvas.categories ?? [], assets: canvas.assets,
});

async function original(service: CanvasService, projectPath: string, asset: CanvasAsset) {
    const bytes = Buffer.alloc(asset.size);
    for (let offset = 0; offset < asset.size; offset += GOAL_CANVAS_LIMITS.downloadChunkBytes) {
        const result = await service.asset({ projectPath, assetId: asset.id, versionId: asset.versionId, offset });
        const chunk = Buffer.from(result.base64, 'base64');
        if (chunk.copy(bytes, offset) !== chunk.length) throw new Error('Incomplete canvas original');
    }
    if (hash(bytes) !== asset.versionId) throw new Error('Canvas original changed during read');
    return bytes;
}

async function readRange(handle: Awaited<ReturnType<typeof open>>, start: number, end: number) {
    const bytes = Buffer.alloc(end - start);
    const result = await handle.read(bytes, 0, bytes.length, start);
    if (result.bytesRead !== bytes.length) throw new Error('Canvas source changed during read');
    return bytes;
}

export async function operateProjectCanvas(service: CanvasService, projectPath: string, input: Command, filesRoot?: string): Promise<CallToolResult> {
    const { action } = input;
    if (!canReadCanvas(action) && !filesRoot) throw new Error('This project canvas connection is read-only');
    if (action === 'change') {
        return text(metadata((await service.mutate({ projectPath, revision: input.revision, changes: input.changes })).canvas));
    }
    if (action === 'save-scene') {
        return text(metadata((await service.saveScene({ projectPath, revision: input.revision, document: input.document, placements: input.placements })).canvas));
    }
    const { canvas } = await service.get({ projectPath });
    if (action === 'list') {
        return text({ ...metadata(canvas), assets: canvas.assets.filter(asset => input.categoryId === undefined ||
            (asset.categoryId ?? null) === input.categoryId) });
    }
    if (action === 'get-scene') return text({ revision: canvas.scene?.revision ?? 0, document: canvas.scene?.document ?? null });
    if (action === 'read-image') {
        const asset = canvas.assets.find(asset => asset.id === input.assetId);
        if (!asset) throw new Error('Canvas asset is unavailable in this project');
        const preview = input.quality === 'preview' && asset.preview ? await service.preview({ projectPath, assetId: asset.id, versionId: asset.versionId }) : undefined;
        const data = preview?.base64 ?? (await original(service, projectPath, asset)).toString('base64');
        return { content: [
            { type: 'text', text: JSON.stringify({ ...asset, quality: preview ? 'preview' : 'original' }) },
            { type: 'image', data, mimeType: preview ? 'image/jpeg' : asset.mimeType },
        ] };
    }
    const root = await realpath(filesRoot!);
    const path = resolve(root, input.path);
    if (action === 'export-package') {
        if (!path.endsWith(GOAL_CANVAS_PACKAGE_EXTENSION)) throw new Error('Choose a .pawscanvas output filename');
        const target = resolve(await safePath(root, dirname(path)), basename(path));
        const bundle = goalCanvasBundleFromSnapshot(canvas, input.assetIds);
        const header = goalCanvasPackageHeader(bundle);
        const file = await open(target, 'wx', 0o600);
        let complete = false;
        try {
            await file.writeFile(header);
            for (const asset of bundle.assets) await file.writeFile(await original(service, projectPath, asset));
            await file.sync();
            complete = true;
        } finally {
            await file.close();
            if (!complete) await unlink(target).catch(() => {});
        }
        return text({ path: target, assets: bundle.assets.length, includesScene: bundle.document !== undefined });
    }
    const source = await openAuthorizedFile(root, path, action === 'import-image' ? GOAL_CANVAS_LIMITS.assetBytes : GOAL_CANVAS_PACKAGE_MAX_BYTES);
    try {
        if (action === 'import-image') {
            const bytes = await readRange(source.handle, 0, source.info.size);
            const mime = detectCodexImage(bytes)?.mime;
            if (!mime) throw new Error('Import a PNG, JPEG, WebP or GIF image');
            const uploadId = randomUUID();
            for (let offset = 0; offset < bytes.length; offset += GOAL_CANVAS_LIMITS.uploadChunkBytes) {
                const end = Math.min(bytes.length, offset + GOAL_CANVAS_LIMITS.uploadChunkBytes);
                const result = await service.import({ projectPath, name: basename(path), mimeType: mime, uploadId,
                    offset, totalSize: bytes.length, base64: bytes.subarray(offset, end).toString('base64') });
                if ('canvas' in result && end === bytes.length) return text(metadata(result.canvas));
                if (!('nextOffset' in result) || result.nextOffset !== end) throw new Error('Canvas image import was not confirmed');
            }
            throw new Error('Canvas image import was incomplete');
        }
        const { bundle, files } = await readGoalCanvasPackage(source.info.size, (start, end) => readRange(source.handle, start, end));
        const incoming = prepareGoalCanvasBundleImport(canvas, bundle, () => 'category-' + randomUUID());
        const existing = new Set(canvas.assets.map(asset => asset.versionId));
        const bundleId = randomUUID();
        for (const { asset, start, end } of files) {
            const bytes = await readRange(source.handle, start, end);
            if (hash(bytes) !== asset.versionId) throw new Error('Canvas package asset failed integrity check');
            if (existing.has(asset.versionId)) continue;
            for (let offset = 0; offset < bytes.length; offset += GOAL_CANVAS_LIMITS.uploadChunkBytes) {
                const next = Math.min(bytes.length, offset + GOAL_CANVAS_LIMITS.uploadChunkBytes);
                const result = await service.stageBundleAsset({ projectPath, bundleId, versionId: asset.versionId,
                    mimeType: asset.mimeType, totalSize: asset.size, offset, base64: bytes.subarray(offset, next).toString('base64') });
                if (result.nextOffset !== (next === bytes.length ? null : next)) throw new Error('Canvas package asset upload is incomplete');
            }
        }
        return text(metadata((await service.commitBundle({ projectPath, revision: canvas.revision, bundleId, bundle: incoming })).canvas));
    } finally {
        await source.handle.close();
    }
}

type Invoke = (input: Command) => Promise<CallToolResult>;
const tools = [
    ['project_canvas_list', 'List this project’s categories, asset IDs, filenames, original hashes and positions. Save the revision for metadata changes.',
        { categoryId: z.string().max(120).nullable().optional() }, 'list'],
    ['project_canvas_read_image', 'Read one project image as an MCP image. Request original quality when inspecting details.',
        { assetId: ids.element, quality: z.enum(['preview', 'original']).default('preview') }, 'read-image'],
    ['project_canvas_get_scene', 'Read the saved tldraw project document and its separate scene revision.', {}, 'get-scene'],
    ['project_canvas_change', 'Apply one atomic batch. Create, rename or delete categories, rename, categorize or remove assets, and batch assets’ X/Y coordinates. Use the revision returned by project_canvas_list.',
        GoalProjectCanvasRequests.goalProjectCanvasMutate.omit({ projectPath: true }).shape, 'change'],
    ['project_canvas_save_scene', 'Save a complete edited tldraw document using the scene revision returned by project_canvas_get_scene. Preserve record IDs and referenced project assets. Can also save corresponding X/Y placements.',
        GoalProjectCanvasRequests.goalProjectCanvasSaveScene.omit({ projectPath: true }).shape, 'save-scene'],
    ['project_canvas_import_image', 'Import a local PNG, JPEG, WebP or GIF from the current Paws session workspace.',
        { path: filePath }, 'import-image'],
    ['project_canvas_import_package', 'Import a .pawscanvas asset package from the current Paws session workspace.',
        { path: filePath }, 'import-package'],
    ['project_canvas_export_package', 'Export the project or selected asset IDs to a new .pawscanvas file in the current session workspace.',
        { path: filePath, assetIds: ids.optional() }, 'export-package'],
] as const;
export const PROJECT_CANVAS_MCP_TOOLS = tools.map(([name]) => name);

export function projectCanvasMcpCall({ action, ...args }: Command) {
    const tool = tools.find(entry => entry[3] === action);
    if (!tool) throw new Error('Unknown project canvas action');
    return { name: tool[0], args };
}

export function registerProjectCanvasTools(server: McpServer, invoke: Invoke, writable: boolean) {
    for (const [name, description, inputSchema, action] of tools) {
        if (!writable && !canReadCanvas(action)) continue;
        server.registerTool(name, {
            description, inputSchema, annotations: { readOnlyHint: canReadCanvas(action) },
        }, async (input: Record<string, unknown>) => {
            try { return await invoke(command.parse({ ...input, action })); }
            catch (error) { return canvasToolError(error); }
        });
    }
}
