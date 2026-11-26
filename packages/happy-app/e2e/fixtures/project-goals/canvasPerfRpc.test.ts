import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GOAL_CANVAS_LIMITS } from '@slopus/happy-wire';
import { expect, it, vi } from 'vitest';
import { projectGoalRequest } from '@/sync/projectGoals';
import { projectCanvasClient } from '../../../sources/components/goalBoard/projectCanvasClient.web';

vi.mock('@/sync/projectGoals', () => ({ projectGoalRequest: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000000' }));

type ReadRecord = { method: string; assetId: string; offset: number; startedAt: number; finishedAt: number; success: boolean };
const hash = (bytes: ArrayBuffer) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

it('bounds original reads and keeps preview RPCs responsive on the isolated relay', async () => {
    const runtimePath = process.env.PAWS_CANVAS_PERF_RUNTIME;
    if (!runtimePath) throw new Error('Set PAWS_CANVAS_PERF_RUNTIME to the isolated --canvas-perf runtime.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    const controller = new URL(runtime.controllerUrl);
    expect(controller.protocol).toBe('http:');
    expect(controller.hostname).toBe('127.0.0.1');
    expect(runtime.projectPath).toContain('/environments/data/envs/');
    expect(runtime.canvasPerf.assets).toHaveLength(29);

    vi.mocked(projectGoalRequest).mockImplementation(async (machineId, method, input) => {
        expect(machineId).toBe(runtime.machineId);
        const response = await fetch(new URL('/rpc', controller), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, input }),
        });
        expect(response.ok).toBe(true);
        return response.json();
    });
    const metrics = async (): Promise<ReadRecord[]> => {
        const response = await fetch(new URL('/metrics', controller));
        expect(response.ok).toBe(true);
        return (await response.json()).canvasReads;
    };
    const before = (await metrics()).length;
    const client = projectCanvasClient(runtime.machineId, runtime.projectPath);
    const snapshot = await client.get();
    const legacy = snapshot.assets.filter(asset => !asset.preview);
    const ready = snapshot.assets.filter(asset => asset.preview);
    expect(legacy).toHaveLength(3);
    expect(ready).toHaveLength(26);
    const [asset] = legacy;
    const [thumbnail] = ready;
    const signal = new AbortController().signal;
    const [file, preview] = await Promise.all([client.readAsset(asset, signal), client.readPreview(thumbnail, signal)]);
    expect(file.size).toBe(asset.size);
    expect(hash(await file.arrayBuffer())).toBe(asset.versionId);
    expect(preview.size).toBe(thumbnail.preview?.size);
    expect(hash(await preview.arrayBuffer())).toBe(thumbnail.preview?.versionId);

    const reads = (await metrics()).slice(before).filter(read => read.assetId === asset.id || read.assetId === thumbnail.id);
    const originalRanges = reads.filter(read => read.method === 'goalProjectCanvasAsset');
    expect(originalRanges.map(range => range.offset).sort((a, b) => a - b)).toEqual(
        Array.from({ length: Math.ceil(asset.size / GOAL_CANVAS_LIMITS.downloadChunkBytes) }, (_, i) => i * GOAL_CANVAS_LIMITS.downloadChunkBytes),
    );
    expect(originalRanges.every(range => range.success)).toBe(true);
    const previewReads = reads.filter(read => read.method === 'goalProjectCanvasPreview');
    expect(previewReads).toHaveLength(1);
    expect(previewReads[0].finishedAt).toBeLessThan(Math.min(...originalRanges.map(range => range.finishedAt)));
    const peak = Math.max(...originalRanges.map(({ startedAt }) =>
        originalRanges.filter(range => range.startedAt <= startedAt && range.finishedAt > startedAt).length));
    expect(peak).toBe(4);
    console.log(JSON.stringify({ originalRanges: originalRanges.length, peak, previewMs: previewReads[0].finishedAt - previewReads[0].startedAt,
        originalMs: Math.max(...originalRanges.map(range => range.finishedAt)) - Math.min(...originalRanges.map(range => range.startedAt)) }));
}, 25_000);
