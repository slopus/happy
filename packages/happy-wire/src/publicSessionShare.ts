import { z } from 'zod';

const publicTextBlockSchema = z.object({
    type: z.literal('text'),
    markdown: z.string().max(2_000_000),
}).strict();

const publicThinkingBlockSchema = z.object({
    type: z.literal('thinking'),
    markdown: z.string().max(2_000_000),
}).strict();

const publicToolBlockSchema = z.object({
    type: z.literal('tool'),
    name: z.string().min(1).max(200),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    title: z.string().max(1_000).optional(),
    body: z.string().max(2_000_000).optional(),
}).strict();

export const publicShareAssetKindSchema = z.enum(['image', 'audio', 'video', 'file']);

const publicAttachmentBlockSchema = z.object({
    type: z.literal('attachment'),
    attachmentId: z.string().uuid(),
    kind: publicShareAssetKindSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    size: z.number().int().min(0).max(500 * 1024 * 1024),
    source: z.enum(['user', 'generated', 'browser_step']).optional(),
    image: z.object({
        width: z.number().int().positive().max(100_000),
        height: z.number().int().positive().max(100_000),
        thumbhash: z.string().max(1_000).optional(),
    }).strict().optional(),
}).strict();

export const publicSessionBlockSchema = z.discriminatedUnion('type', [
    publicTextBlockSchema,
    publicThinkingBlockSchema,
    publicToolBlockSchema,
    publicAttachmentBlockSchema,
]);

export const publicSessionSourceProviderSchema = z.enum(['paws', 'codex', 'claude-code']);

export const publicSessionThemePackSchema = z.enum([
    'caramel', 'gingham', 'terminal', 'acorn', 'sage', 'sakura', 'grape',
]);

const PEXELS_ATTRIBUTION_HOSTS = new Set(['pexels.com', 'www.pexels.com']);

function isCanonicalPexelsAttributionUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && PEXELS_ATTRIBUTION_HOSTS.has(url.hostname.toLowerCase())
            && !url.username
            && !url.password
            && !url.port;
    } catch {
        return false;
    }
}

const publicSessionPexelsUrlSchema = z.string()
    .url()
    .max(2_000)
    .refine(isCanonicalPexelsAttributionUrl, 'Expected a canonical HTTPS Pexels URL');

export const publicSessionCoverAttributionSchema = z.object({
    photoId: z.number().int().positive(),
    photographer: z.string().min(1).max(500),
    photographerUrl: publicSessionPexelsUrlSchema,
    photoUrl: publicSessionPexelsUrlSchema,
}).strict();

export const publicSessionCoverMimeTypeSchema = z.enum([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
]);

const publicSessionCoverSchema = z.object({
    assetId: z.string().uuid(),
    mimeType: publicSessionCoverMimeTypeSchema,
    size: z.number().int().positive().max(100 * 1024 * 1024),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    thumbhash: z.string().max(1_000).optional(),
    attribution: publicSessionCoverAttributionSchema.optional(),
}).strict();

const publicSessionSnapshotFields = {
    title: z.string().min(1).max(500),
    sharedAt: z.number().int().positive(),
    source: z.object({
        provider: publicSessionSourceProviderSchema,
    }).strict().optional(),
    presentation: z.object({
        groupToolCalls: z.boolean(),
    }).strict().optional(),
    messages: z.array(z.object({
        id: z.string().min(1).max(200),
        role: z.enum(['user', 'assistant', 'system']),
        createdAt: z.number().int().nonnegative(),
        blocks: z.array(publicSessionBlockSchema).max(2_000),
    }).strict()).max(20_000),
};

export const publicSessionSnapshotV1Schema = z.object({
    version: z.literal(1),
    ...publicSessionSnapshotFields,
}).strict();

export const publicSessionSnapshotV2Schema = z.object({
    version: z.literal(2),
    ...publicSessionSnapshotFields,
    appearance: z.object({
        themePack: publicSessionThemePackSchema,
        cover: publicSessionCoverSchema.optional(),
    }).strict(),
}).strict();

export const publicSessionSnapshotSchema = z.discriminatedUnion('version', [
    publicSessionSnapshotV1Schema,
    publicSessionSnapshotV2Schema,
]);

export type PublicShareAssetKind = z.infer<typeof publicShareAssetKindSchema>;
export type PublicSessionBlock = z.infer<typeof publicSessionBlockSchema>;
export type PublicSessionCover = z.infer<typeof publicSessionCoverSchema>;
export type PublicSessionSourceProvider = z.infer<typeof publicSessionSourceProviderSchema>;
export type PublicSessionThemePack = z.infer<typeof publicSessionThemePackSchema>;
export type PublicSessionSnapshotV1 = z.infer<typeof publicSessionSnapshotV1Schema>;
export type PublicSessionSnapshotV2 = z.infer<typeof publicSessionSnapshotV2Schema>;
export type PublicSessionSnapshot = z.infer<typeof publicSessionSnapshotSchema>;
