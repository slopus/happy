import { db } from '@/storage/db';
import { deletePublicShareGeneration } from './publicSessionShareStorage';
import { log } from '@/utils/log';
import { onShutdown } from '@/utils/shutdown';

const CLEANUP_BATCH_SIZE = 100;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

type CleanupDraft = {
    id: string;
    shareId: string;
    share: { activeGeneration: string | null; revokedAt: Date | null };
};

export async function cleanupPublicSessionShareGeneration(shareId: string, generation: string): Promise<void> {
    // Storage first, row second. If object deletion fails, the draft and asset
    // rows remain durable so the scheduled worker can retry instead of leaving
    // an untraceable object-store orphan.
    await deletePublicShareGeneration(shareId, generation);
    await db.publicSessionShareDraft.deleteMany({ where: { id: generation, shareId } });
}

export async function cleanupExpiredPublicSessionShareDrafts(now = new Date()): Promise<number> {
    const drafts = await db.publicSessionShareDraft.findMany({
        where: { expiresAt: { lte: now }, status: { not: 'published' } },
        select: {
            id: true,
            shareId: true,
            share: { select: { activeGeneration: true, revokedAt: true } },
        },
        take: CLEANUP_BATCH_SIZE,
        orderBy: { expiresAt: 'asc' },
    }) as CleanupDraft[];
    let cleaned = 0;
    for (const draft of drafts) {
        if (!draft.share.revokedAt && draft.share.activeGeneration === draft.id) continue;
        try {
            await cleanupPublicSessionShareGeneration(draft.shareId, draft.id);
            cleaned += 1;
        } catch (error) {
            log({ module: 'public-session-share-cleanup', level: 'error', draftId: draft.id, error }, 'Failed to clean public share draft; retaining it for retry');
        }
    }
    return cleaned;
}

export function startPublicSessionShareCleanup(): void {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await cleanupExpiredPublicSessionShareDrafts();
        } catch (error) {
            log({ module: 'public-session-share-cleanup', level: 'error', error }, 'Public share cleanup pass failed; it will be retried');
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => { void run(); }, CLEANUP_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    onShutdown('public-session-share-cleanup', async () => clearInterval(timer));
    void run();
}
