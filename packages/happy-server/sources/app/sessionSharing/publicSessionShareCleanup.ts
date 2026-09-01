import { db } from '@/storage/db';
import { deletePublicShareGeneration } from './publicSessionShareStorage';
import { log } from '@/utils/log';
import { onShutdown } from '@/utils/shutdown';

const CLEANUP_BATCH_SIZE = 100;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const CAPABILITY_DELETE_GRACE_MS = 60 * 60 * 1000;
const DRAFT_DELETE_GRACE_MS = 60 * 60 * 1000;

type CleanupDraft = {
    id: string;
    shareId: string;
    share: { activeGeneration: string | null; revokedAt: Date | null };
};

type ExpiredCapabilityShare = {
    id: string;
    activeGeneration: string | null;
    revokedAt: Date | null;
    drafts: Array<{ id: string }>;
};

export async function cleanupPublicSessionShareGeneration(shareId: string, generation: string): Promise<void> {
    // Storage first, row second. If object deletion fails, the draft and asset
    // rows remain durable so the scheduled worker can retry instead of leaving
    // an untraceable object-store orphan.
    await deletePublicShareGeneration(shareId, generation);
    await db.publicSessionShareDraft.deleteMany({ where: { id: generation, shareId } });
}

export async function cleanupExpiredPublicSessionShareDrafts(now = new Date()): Promise<number> {
    const deleteBefore = new Date(now.getTime() - DRAFT_DELETE_GRACE_MS);
    const drafts = await db.publicSessionShareDraft.findMany({
        where: { expiresAt: { lte: deleteBefore }, status: { not: 'published' } },
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

export async function cleanupExpiredCapabilityShares(now = new Date()): Promise<number> {
    const shares = await db.publicSessionShare.findMany({
        where: { managementTokenHash: { not: null }, expiresAt: { lte: now } },
        select: {
            id: true,
            activeGeneration: true,
            revokedAt: true,
            drafts: { select: { id: true } },
        },
        take: CLEANUP_BATCH_SIZE,
        orderBy: { expiresAt: 'asc' },
    }) as ExpiredCapabilityShare[];
    let cleaned = 0;
    for (const share of shares) {
        try {
            if (!share.revokedAt) {
                // Claim the share first, then leave a durable tombstone for one
                // request window. In-flight uploads will observe the lifecycle
                // change after their object write and remove that generation;
                // the next cleanup pass performs the final deletion.
                await db.publicSessionShare.updateMany({
                    where: {
                        id: share.id,
                        managementTokenHash: { not: null },
                        expiresAt: { lte: now },
                        revokedAt: null,
                    },
                    data: { revokedAt: now, lifecycleVersion: { increment: 1 } },
                });
                continue;
            }
            if (share.revokedAt.getTime() > now.getTime() - CAPABILITY_DELETE_GRACE_MS) continue;
            const generations = new Set(share.drafts.map((draft) => draft.id));
            if (share.activeGeneration) generations.add(share.activeGeneration);
            for (const generation of generations) {
                await deletePublicShareGeneration(share.id, generation);
            }
            const deleted = await db.publicSessionShare.deleteMany({
                where: {
                    id: share.id,
                    managementTokenHash: { not: null },
                    expiresAt: { lte: now },
                    revokedAt: share.revokedAt,
                },
            });
            cleaned += deleted.count;
        } catch (error) {
            log({ module: 'public-session-share-cleanup', level: 'error', shareId: share.id, error }, 'Failed to clean expired capability share; retaining it for retry');
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
            await cleanupExpiredCapabilityShares();
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
