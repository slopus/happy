import { MMKV } from 'react-native-mmkv';
import { z } from 'zod';
import type { PublicSessionThemePack } from '@slopus/happy-wire';
import { THEME_PACK_IDS } from '@/themePacksData';
import {
    publicSessionCoverSelectionSchema,
    type PublicSessionShareJob,
    type PublicSessionShareQueueStorage,
} from './publicSessionShareQueue';

const queueStorage = new MMKV({ id: 'public-session-share-queue' });
const STORAGE_KEY = 'jobs-v1';

const themePackSchema = z.custom<PublicSessionThemePack>((value) => (
    typeof value === 'string' && THEME_PACK_IDS.includes(value)
)).catch('caramel');

const jobSchema = z.object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    title: z.string(),
    requestedAt: z.number().finite(),
    cutoffSeq: z.number().int().nonnegative(),
    ownerId: z.string().min(1),
    serverUrl: z.string().url(),
    groupToolCalls: z.boolean(),
    themePack: themePackSchema,
    coverSelection: publicSessionCoverSelectionSchema.optional().catch(undefined),
    status: z.enum(['queued', 'running', 'ready', 'failed']),
    progress: z.object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
    }),
    updatedAt: z.number().finite(),
    publicId: z.string().min(1).optional(),
    publishedAt: z.number().finite().optional(),
    error: z.string().optional(),
    notificationPending: z.boolean(),
});

export function parsePublicSessionShareJobs(raw: string | null | undefined): PublicSessionShareJob[] {
    if (!raw) return [];
    try {
        const parsed = z.array(jobSchema).safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

export const publicSessionShareQueueStorage: PublicSessionShareQueueStorage = {
    load: () => parsePublicSessionShareJobs(queueStorage.getString(STORAGE_KEY)),
    save: (jobs) => queueStorage.set(STORAGE_KEY, JSON.stringify(jobs)),
};

export function clearPublicSessionShareQueueStorage(): void {
    queueStorage.clearAll();
}
