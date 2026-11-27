import { z } from 'zod';

export const PortableContextBoundarySchema = z.object({
    id: z.string().uuid(), afterSeq: z.number().int().nonnegative(),
}).strict();
export type PortableContextBoundary = z.infer<typeof PortableContextBoundarySchema>;

/** Sourced historical data, never executable provider tool calls or reasoning. */
export const PortableContextAttachmentSchema = z.object({
    id: z.string().min(1), sourceSessionId: z.string().min(1), ref: z.string().min(1),
    name: z.string(), size: z.number().int().nonnegative(),
    kind: z.enum(['image', 'file', 'audio', 'video']), mimeType: z.string().optional(),
    encrypted: z.boolean(),
}).strict();
export const PortableContextItemSchema = z.object({
    id: z.string().min(1), sourceSessionId: z.string().min(1), seq: z.number().int().positive(),
    role: z.enum(['user', 'assistant', 'tool', 'event']), text: z.string(),
    attachments: z.array(PortableContextAttachmentSchema).optional(),
    /** Legacy relay records may have dropped a completed native result body. */
    nativeToolCallId: z.string().optional(), nativeResultMissing: z.literal(true).optional(),
}).strict();
export const PortableContextHeadSchema = z.object({
    sessionId: z.string().min(1), throughSeq: z.number().int().nonnegative(),
    /** The most recent explicit clear/rewind boundary within this segment. */
    afterSeq: z.number().int().nonnegative(),
}).strict();
export const PortableContextSnapshotSchema = z.object({
    version: z.literal(1), id: z.string().uuid(), rootSessionId: z.string().min(1),
    sourceSessionId: z.string().min(1), heads: z.array(PortableContextHeadSchema),
    items: z.array(PortableContextItemSchema),
}).strict();
/** Only sent over authenticated encrypted RPC; never included in model text. */
export const PortableContextArchiveSchema = z.object({
    snapshot: PortableContextSnapshotSchema,
    blobKeys: z.record(z.string(), z.string()),
}).strict();
export const PortableContextDescriptorSchema = z.object({
    version: z.literal(1), id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rootSessionId: z.string().min(1), sourceSessionId: z.string().min(1),
    heads: z.array(PortableContextHeadSchema),
}).strict();
export const PortableContextUploadSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('append'), snapshotId: z.string().uuid(), index: z.number().int().nonnegative(),
        chunk: z.string().max(48000) }).strict(),
    z.object({ action: z.literal('commit'), snapshotId: z.string().uuid(), chunks: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export const PortableThreadReadSchema = z.object({
    itemId: z.string().optional(), textOffset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(16000).optional(),
    offset: z.number().int().nonnegative().optional(), query: z.string().max(1000).optional(),
}).strict();
export const PortableThreadAttachmentSchema = z.object({ attachmentId: z.string().min(1) }).strict();
export type PortableContextAttachment = z.infer<typeof PortableContextAttachmentSchema>;
export type PortableContextItem = z.infer<typeof PortableContextItemSchema>;
export type PortableContextHead = z.infer<typeof PortableContextHeadSchema>;
export type PortableContextSnapshot = z.infer<typeof PortableContextSnapshotSchema>;
export type PortableContextArchive = z.infer<typeof PortableContextArchiveSchema>;
export type PortableContextDescriptor = z.infer<typeof PortableContextDescriptorSchema>;

/** Static source scope, shared by daemon restore receipts and App snapshot checks. */
export function portableNativeSourceIdentity(metadata: {
    machineId?: string; path?: string; flavor?: string | null; claudeSessionId?: string; codexThreadId?: string;
    codexAccountProfileId?: string; codexMagpieConnection?: boolean; claudeModelConnectionKey?: string;
    continuationOfSessionId?: string; conversationRootSessionId?: string; parentSessionId?: string; forkedFromMessageId?: string;
    portableContextBoundary?: { id: string; afterSeq: number };
    portableContext?: { id: string; sha256: string };
}): string {
    return JSON.stringify([metadata.machineId, metadata.path, metadata.flavor, metadata.claudeSessionId, metadata.codexThreadId,
        metadata.codexAccountProfileId, metadata.codexMagpieConnection === true, metadata.claudeModelConnectionKey,
        metadata.continuationOfSessionId, metadata.conversationRootSessionId, metadata.parentSessionId, metadata.forkedFromMessageId,
        metadata.portableContextBoundary?.id, metadata.portableContextBoundary?.afterSeq,
        metadata.portableContext?.id, metadata.portableContext?.sha256]);
}
