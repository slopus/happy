import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectGoalRequest } from '@/sync/projectGoals';
import { projectCanvasClient, type ProjectCanvasAsset } from './projectCanvasClient.web';

vi.mock('@/sync/projectGoals', () => ({ projectGoalRequest: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'f43222a5-0b7d-4da4-8bd5-15d66f810a7f' }));

const request = vi.mocked(projectGoalRequest);
const projectPath = '/goals/Creative Web';
const client = projectCanvasClient('machine', projectPath);
const originalBytes = Buffer.alloc(0x10000 + 3, 20);
const originalHash = createHash('sha256').update(originalBytes).digest('hex');
const restoredAsset: ProjectCanvasAsset = {
    id: `asset-${originalHash}`, versionId: originalHash, name: 'pose.png', mimeType: 'image/png', size: originalBytes.length, x: 32, y: 32,
};
const snapshot = { id: `canvas-${'a'.repeat(64)}`, revision: 2, assets: [restoredAsset] };

beforeEach(() => { request.mockReset(); });

describe('project canvas RPC client', () => {
    it('uploads independently encoded ranges and binds them to one project and upload', async () => {
        const size = 256 * 1024 + 3;
        const bytes = Buffer.alloc(size, 37);
        request.mockResolvedValueOnce({ success: true, nextOffset: 256 * 1024 });
        request.mockResolvedValueOnce({ success: true, canvas: snapshot });

        const saved = await client.importFile(new File([bytes], 'pose.png', { type: 'image/png' }), new AbortController().signal);
        expect(saved).toEqual(snapshot);
        expect(request).toHaveBeenCalledTimes(2);
        for (const [index, call] of request.mock.calls.entries()) {
            const offset = index * 256 * 1024;
            expect(call).toEqual(['machine', 'goalProjectCanvasImport', {
                projectPath, name: 'pose.png', mimeType: 'image/png', totalSize: size, offset,
                uploadId: 'f43222a5-0b7d-4da4-8bd5-15d66f810a7f', base64: bytes.subarray(offset, offset + 256 * 1024).toString('base64'),
            }]);
        }
    });

    it('reads original asset versions and rejects a mismatched cursor', async () => {
        const size = restoredAsset.size;
        const bytes = originalBytes;
        request.mockResolvedValueOnce({ success: true, base64: bytes.subarray(0, 0x10000).toString('base64'), size, nextOffset: 0x10000 });
        request.mockResolvedValueOnce({ success: true, base64: bytes.subarray(0x10000).toString('base64'), size, nextOffset: null });
        const file = await client.readAsset(restoredAsset, new AbortController().signal);
        expect(file.name).toBe(restoredAsset.name);
        expect(file.type).toBe(restoredAsset.mimeType);
        expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
        expect(request.mock.calls).toEqual([0, 0x10000].map(offset => ['machine', 'goalProjectCanvasAsset', {
            projectPath, assetId: restoredAsset.id, versionId: restoredAsset.versionId, offset,
        }]));

        request.mockResolvedValueOnce({ success: true, base64: bytes.subarray(0, 0x10000).toString('base64'), size, nextOffset: null });
        await expect(client.readAsset(restoredAsset, new AbortController().signal)).rejects.toThrow('invalid byte range');
    });

    it('rejects complete bytes for the wrong source version', async () => {
        const asset = { ...restoredAsset, size: 4 };
        request.mockResolvedValueOnce({ success: true, base64: 'AQIDBA==', size: 4, nextOffset: null });
        await expect(client.readAsset(asset, new AbortController().signal)).rejects.toThrow('do not match the saved version');
    });

    it('reads at most four ranges at once and assembles out-of-order replies by offset', async () => {
        const rangeSize = 0x10000;
        const bytes = Buffer.alloc(rangeSize * 4 + 3);
        for (let offset = 0; offset < bytes.length; offset += rangeSize) {
            bytes.fill(offset / rangeSize + 1, offset, Math.min(offset + rangeSize, bytes.length));
        }
        const versionId = createHash('sha256').update(bytes).digest('hex');
        const asset = { ...restoredAsset, id: `asset-${versionId}`, versionId, size: bytes.length };
        const completeRange = new Map<number, () => void>();
        let notifyFinalRange!: () => void;
        const finalRangeStarted = new Promise<void>(resolve => { notifyFinalRange = resolve; });
        request.mockImplementation((_machine, _method, input) => new Promise(resolve => {
            const { offset } = input as { offset: number };
            const end = Math.min(offset + rangeSize, bytes.length);
            completeRange.set(offset, () => resolve({
                success: true, base64: bytes.subarray(offset, end).toString('base64'), size: bytes.length,
                nextOffset: end === bytes.length ? null : end,
            }));
            if (end === bytes.length) notifyFinalRange();
        }));

        const reading = client.readAsset(asset, new AbortController().signal);
        expect([...completeRange.keys()]).toEqual([0, rangeSize, rangeSize * 2, rangeSize * 3]);
        for (const offset of [rangeSize * 3, rangeSize, rangeSize * 2, 0]) completeRange.get(offset)!();
        await finalRangeStarted;
        completeRange.get(rangeSize * 4)!();
        expect(Buffer.from(await (await reading).arrayBuffer())).toEqual(bytes);
    });

    it('does not fetch another range after leaving the project', async () => {
        const lifecycle = new AbortController();
        request.mockImplementationOnce(async () => { lifecycle.abort(); return {}; });
        await expect(client.readAsset(restoredAsset, lifecycle.signal)).rejects.toHaveProperty('name', 'AbortError');
        expect(request).toHaveBeenCalledTimes(1);
    });
});
