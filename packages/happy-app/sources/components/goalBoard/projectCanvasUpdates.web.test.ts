import { describe, expect, it } from 'vitest';
import { applyProjectCanvasPreviewReceipt } from './projectCanvasUpdates.web';

const asset = { id: `asset-${'a'.repeat(64)}`, versionId: 'a'.repeat(64), name: 'image.png', mimeType: 'image/png' as const, size: 4, x: 1, y: 2 };
const previewAsset = { ...asset, preview: { versionId: 'b'.repeat(64), size: 4 } };
const canvas = { id: `canvas-${'c'.repeat(64)}`, revision: 4, assets: [asset], scene: { revision: 2, document: '{"store":{}}' } };
const receipt = { canvasId: canvas.id, baseRevision: 4, revision: 5, asset: previewAsset };

describe('compact preview receipts', () => {
    it('advances one contiguous preview while retaining the scene document', () => {
        expect(applyProjectCanvasPreviewReceipt(canvas, receipt)).toEqual({ ...canvas, revision: 5, assets: [previewAsset] });
    });
    it('treats an already applied receipt as idempotent', () => {
        const current = { ...canvas, revision: 5, assets: [previewAsset] };
        expect(applyProjectCanvasPreviewReceipt(current, receipt)).toBe(current);
    });
    it.each([
        { ...receipt, baseRevision: 5, revision: 6 },
        { ...receipt, canvasId: `canvas-${'d'.repeat(64)}` },
        { ...receipt, asset: { ...previewAsset, versionId: 'e'.repeat(64) } },
        { ...receipt, asset: { ...previewAsset, id: `asset-${'e'.repeat(64)}` } },
    ])('requires an authoritative snapshot when the receipt cannot be applied safely', change => {
        expect(applyProjectCanvasPreviewReceipt(canvas, change)).toBeUndefined();
    });
    it('does not overwrite a newer authoritative snapshot with an old receipt', () => {
        const current = { ...canvas, revision: 7 };
        expect(applyProjectCanvasPreviewReceipt(current, receipt)).toBe(current);
    });
});
