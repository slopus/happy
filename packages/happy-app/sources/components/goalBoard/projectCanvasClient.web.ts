import { randomUUID } from 'expo-crypto';
import {
    GOAL_CANVAS_LIMITS, GoalCanvasAssetSchema, GoalCanvasImageMimeSchema,
    GoalProjectCanvasRequests, GoalProjectCanvasResponses, type GoalProjectCanvas, type GoalProjectCanvasChange,
    goalCanvasBundleFromSnapshot, goalCanvasPackageHeader, prepareGoalCanvasBundleImport, readGoalCanvasPackage,
} from '@slopus/happy-wire';
import type { z } from 'zod';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { projectFileHash } from '@/sync/projectFileHash';
import { projectGoalRequest } from '@/sync/projectGoals';

export const projectCanvasImageTypes = GoalCanvasImageMimeSchema.options;
const uploadChunkSize = Math.min(256 * 1024, GOAL_CANVAS_LIMITS.uploadChunkBytes);
const downloadChunkSize = GOAL_CANVAS_LIMITS.downloadChunkBytes;

export type ProjectCanvasAsset = z.infer<typeof GoalCanvasAssetSchema>;
export type ProjectCanvasSnapshot = GoalProjectCanvas;
export type ProjectCanvasPlacement = Pick<ProjectCanvasAsset, 'id' | 'x' | 'y'>;

export function projectCanvasClient(machineId: string, projectPath: string) {
    async function request<K extends keyof typeof GoalProjectCanvasRequests>(method: K, input: object = {}, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const argumentsForProject = GoalProjectCanvasRequests[method].parse({ projectPath, ...input });
        const response = await projectGoalRequest(machineId, method, argumentsForProject);
        signal?.throwIfAborted();
        const parsed = GoalProjectCanvasResponses[method].parse(response) as z.infer<(typeof GoalProjectCanvasResponses)[K]>;
        if (!parsed.success) throw new Error(parsed.error);
        return parsed as Extract<typeof parsed, { success: true }>;
    }

    return {
        async get(signal?: AbortSignal): Promise<ProjectCanvasSnapshot> {
            return (await request('goalProjectCanvasGet', {}, signal)).canvas;
        },
        async importFile(file: File, signal: AbortSignal): Promise<ProjectCanvasSnapshot> {
            const mimeType = GoalCanvasImageMimeSchema.parse(file.type);
            const totalSize = file.size;
            if (totalSize < 1 || totalSize > GOAL_CANVAS_LIMITS.assetBytes) throw new Error('Invalid canvas import size');
            const uploadId = randomUUID();

            for (let offset = 0; offset < totalSize; offset += uploadChunkSize) {
                signal.throwIfAborted();
                const end = Math.min(offset + uploadChunkSize, totalSize);
                const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
                const response = await request('goalProjectCanvasImport', {
                    name: file.name, mimeType, uploadId, offset, totalSize, base64: encodeBase64(bytes),
                }, signal);
                if ('canvas' in response) {
                    if (end !== totalSize) throw new Error('Canvas import completed before all bytes were sent');
                    return response.canvas;
                }
                if (response.nextOffset !== end) throw new Error('Canvas import did not acknowledge the uploaded range');
            }
            throw new Error('Canvas import did not return the saved canvas');
        },
        async readAsset(asset: ProjectCanvasAsset, signal: AbortSignal): Promise<File> {
            const bytes = new Uint8Array(asset.size);
            for (let offset = 0; offset < bytes.length; offset += downloadChunkSize) {
                const response = await request('goalProjectCanvasAsset', {
                    assetId: asset.id, versionId: asset.versionId, offset,
                }, signal);
                const end = Math.min(offset + downloadChunkSize, bytes.length);
                if (response.base64.length > Math.ceil((end - offset) / 3) * 4) throw new Error('Unexpected canvas asset range size');
                const chunk = decodeBase64(response.base64);
                if (response.size !== bytes.length || chunk.length !== end - offset || response.nextOffset !== (end === bytes.length ? null : end)) {
                    throw new Error('Canvas asset returned an invalid byte range');
                }
                bytes.set(chunk, offset);
            }
            if (await projectFileHash(bytes) !== asset.versionId) throw new Error('Canvas asset bytes do not match the saved version');
            signal.throwIfAborted();
            return new File([bytes], asset.name, { type: asset.mimeType });
        },
        async readPreview(asset: ProjectCanvasAsset, signal: AbortSignal): Promise<Blob> {
            if (!asset.preview) throw new Error('Canvas preview is unavailable');
            const response = await request('goalProjectCanvasPreview', { assetId: asset.id, versionId: asset.versionId }, signal);
            const bytes = decodeBase64(response.base64);
            if (response.size !== asset.preview.size || bytes.length !== asset.preview.size ||
                await projectFileHash(bytes) !== asset.preview.versionId) {
                throw new Error('Canvas preview bytes do not match the saved version');
            }
            signal.throwIfAborted();
            return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
        },
        async putPreview(asset: ProjectCanvasAsset, preview: Blob, signal: AbortSignal): Promise<ProjectCanvasSnapshot> {
            const bytes = new Uint8Array(await preview.arrayBuffer());
            return (await request('goalProjectCanvasPutPreview', {
                assetId: asset.id, versionId: asset.versionId, base64: encodeBase64(bytes),
            }, signal)).canvas;
        },
        async saveLayout(revision: number, placements: ProjectCanvasPlacement[]): Promise<ProjectCanvasSnapshot> {
            return (await request('goalProjectCanvasLayout', { revision, placements })).canvas;
        },
        async saveScene(revision: number, document: string, placements: ProjectCanvasPlacement[], signal: AbortSignal) {
            return (await request('goalProjectCanvasSaveScene', { revision, document, placements }, signal)).canvas;
        },
        async mutate(revision: number, changes: readonly GoalProjectCanvasChange[], signal: AbortSignal) {
            return (await request('goalProjectCanvasMutate', { revision, changes }, signal)).canvas;
        },
        async importPackage(file: File, canvas: ProjectCanvasSnapshot, signal: AbortSignal) {
            const { bundle, files } = await readGoalCanvasPackage(file.size, async (start, end) =>
                new Uint8Array(await file.slice(start, end).arrayBuffer()));
            const incoming = prepareGoalCanvasBundleImport(canvas, bundle, () => 'category-' + randomUUID());
            const bundleId = randomUUID();
            const existing = new Set(canvas.assets.map(asset => asset.versionId));
            for (const { asset, start, end } of files) {
                signal.throwIfAborted();
                const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
                if (await projectFileHash(bytes) !== asset.versionId) throw new Error('Canvas package asset failed integrity check');
                if (existing.has(asset.versionId)) continue;
                for (let offset = 0; offset < bytes.length; offset += uploadChunkSize) {
                    const next = Math.min(bytes.length, offset + uploadChunkSize);
                    const response = await request('goalProjectCanvasStageBundleAsset', {
                        bundleId, versionId: asset.versionId, mimeType: asset.mimeType, totalSize: asset.size,
                        offset, base64: encodeBase64(bytes.subarray(offset, next)),
                    }, signal);
                    if (response.nextOffset !== (next === bytes.length ? null : next)) throw new Error('Canvas package asset upload is incomplete');
                }
            }
            return (await request('goalProjectCanvasCommitBundle', { revision: canvas.revision, bundleId, bundle: incoming }, signal)).canvas;
        },
        async exportPackage(canvas: ProjectCanvasSnapshot, assetIds: readonly string[] | undefined, signal: AbortSignal) {
            const bundle = goalCanvasBundleFromSnapshot(canvas, assetIds);
            const parts: BlobPart[] = [goalCanvasPackageHeader(bundle)];
            for (const asset of bundle.assets) parts.push(await this.readAsset(asset, signal));
            signal.throwIfAborted();
            return new Blob(parts, { type: 'application/octet-stream' });
        },
    };
}
