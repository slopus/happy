import type { GoalProjectCanvasPreviewReceipt } from '@slopus/happy-wire';
import type { ProjectCanvasSnapshot } from './projectCanvasClient.web';

export type ProjectCanvasPreviewReceipt = Omit<GoalProjectCanvasPreviewReceipt, 'success'>;

export function applyProjectCanvasPreviewReceipt(current: ProjectCanvasSnapshot, receipt: ProjectCanvasPreviewReceipt): ProjectCanvasSnapshot | undefined {
    if (current.id !== receipt.canvasId) return;
    if (receipt.revision < current.revision) return current;
    const index = current.assets.findIndex(asset => asset.id === receipt.asset.id);
    const asset = current.assets[index];
    if (!asset || asset.versionId !== receipt.asset.versionId) return;
    if (receipt.revision === current.revision) {
        return JSON.stringify(asset) === JSON.stringify(receipt.asset) ? current : undefined;
    }
    if (receipt.baseRevision !== current.revision || receipt.revision !== receipt.baseRevision + 1) return;
    const assets = [...current.assets];
    assets[index] = receipt.asset;
    return { ...current, revision: receipt.revision, assets };
}
