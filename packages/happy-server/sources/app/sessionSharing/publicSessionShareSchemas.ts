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
    status: z.enum(['running', 'completed', 'failed']),
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
}).strict();

export const publicSessionBlockSchema = z.discriminatedUnion('type', [
    publicTextBlockSchema,
    publicThinkingBlockSchema,
    publicToolBlockSchema,
    publicAttachmentBlockSchema,
]);

export const publicSessionSnapshotSchema = z.object({
    version: z.literal(1),
    title: z.string().min(1).max(500),
    sharedAt: z.number().int().positive(),
    messages: z.array(z.object({
        id: z.string().min(1).max(200),
        role: z.enum(['user', 'assistant', 'system']),
        createdAt: z.number().int().nonnegative(),
        blocks: z.array(publicSessionBlockSchema).max(2_000),
    }).strict()).max(20_000),
}).strict();

export type PublicSessionSnapshot = z.infer<typeof publicSessionSnapshotSchema>;
