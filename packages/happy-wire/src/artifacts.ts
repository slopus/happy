import { z } from 'zod';

// v2 attests canonical catalog filtering and whole-revision chat context.
export const ARTIFACT_PROTOCOL = 2 as const;
export const ARTIFACT_LIMITS = { files: 128, entryBytes: 2 * 1024 * 1024, resourceBytes: 10 * 1024 * 1024, versionBytes: 32 * 1024 * 1024, page: 30, chunk: 256 * 1024 } as const;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const path = z.string().min(1).max(8192);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ArtifactRefSchema = z.object({ workspaceId: id, artifactId: id });
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const ArtifactReadRefSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('version'), versionId: id }), z.object({ kind: z.literal('working'), readId: id })]);
export type ArtifactReadRef = z.infer<typeof ArtifactReadRefSchema>;
export const ArtifactFileSchema = z.object({ path, sha256: hash, size: z.number().int().min(0).max(ARTIFACT_LIMITS.resourceBytes), mode: z.number().int().min(0).max(511), mime: z.string().max(128) });
export const ArtifactManifestSchema = z.object({ entryPath: path, files: z.array(ArtifactFileSchema).max(128), digest: hash });
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export const ArtifactVersionSchema = z.object({
  id, artifactId: id, sequence: z.number().int().positive(), createdAt: z.number(),
  source: z.enum(['baseline', 'ai', 'manual', 'external', 'restore']), prompt: z.string().max(65536).optional(), summary: z.string().max(2048),
  runId: id.optional(), parentVersionId: id.optional(), restoreFromVersionId: id.optional(), manifestDigest: hash,
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export const ArtifactSchema = z.object({ id, workspaceId: id, name: z.string().max(512), kind: z.enum(['html', 'markdown']), entryPath: path, managedPaths: z.array(path).min(1).max(128), currentVersionId: id });
export type Artifact = z.infer<typeof ArtifactSchema>;
export const ArtifactChangedSchema = ArtifactRefSchema.extend({ currentVersionId: id, workingRevision: hash, sequence: z.number().int().nonnegative(), operationId: id.optional() });
export type ArtifactChanged = z.infer<typeof ArtifactChangedSchema>;
export type ArtifactErrorCode = 'UNAVAILABLE' | 'PERMISSION_DENIED' | 'PATH_OUT_OF_BOUNDS' | 'NOT_FOUND' | 'CONFLICT' | 'WRITER_ACTIVE' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_PREVIEW' | 'INCOMPLETE_VERSION' | 'COMMIT_PENDING' | 'PARTIAL_COMMIT' | 'READ_UNSTABLE' | 'INTERNAL';
export type ArtifactResult<T> = { ok: true; value: T } | { ok: false; error: { code: ArtifactErrorCode; message: string; operationId?: string; actualRevision?: string } };
const base = ArtifactRefSchema.extend({ operationId: id, expectedRevision: hash });
export const ArtifactRequests = {
  artifactCapabilities: z.object({}),
  artifactCatalog: z.object({ workspaceId: id.optional(), root: path.optional() }),
  // The root is explicitly authorized by the existing machine/session channel.
  artifactRegister: z.object({ root: path, entryPath: path, managedPaths: z.array(path).min(1).max(128), operationId: id, name: z.string().max(512).optional() }),
  artifactRead: ArtifactRefSchema.extend({ versionId: id.optional() }),
  artifactResourceRead: ArtifactRefSchema.extend({ readRef: ArtifactReadRefSchema, path, offset: z.number().int().nonnegative(), length: z.number().int().min(1).max(ARTIFACT_LIMITS.chunk) }),
  artifactVersions: ArtifactRefSchema.extend({ cursor: id.optional() }),
  artifactSave: base.extend({ entryContent: z.string().max(ARTIFACT_LIMITS.entryBytes), changes: z.array(z.object({ path, content: z.string().max(Math.ceil(ARTIFACT_LIMITS.resourceBytes / 3) * 4).nullable() })).max(128).optional(), prompt: z.string().max(65536).optional() }),
  artifactRestore: base.extend({ versionId: id }),
  artifactRename: base.extend({ nextName: z.string().min(1).max(512), nextEntryPath: path.optional() }),
  artifactOperation: z.object({ workspaceId: id, operationId: id }),
  artifactResolveOperation: z.object({ workspaceId: id, operationId: id, resolutionId: id, action: z.enum(['resume', 'rollback']), expectedObservedRevision: hash }),
} as const;
export type ArtifactMutationResult = { version: ArtifactVersion; workingRevision: string; unchanged: boolean };
export type ArtifactReadResult = { artifact: Artifact; manifest: ArtifactManifest; entryContent: string; readRef: ArtifactReadRef; workingRevision: string; workingState: 'clean' | 'dirty' | 'writing' | 'recovery-required'; pendingOperationId?: string };

export const ArtifactMutationResultSchema = z.object({ version: ArtifactVersionSchema, workingRevision: hash, unchanged: z.boolean() });
export const ArtifactReadResultSchema = z.object({ artifact: ArtifactSchema, manifest: ArtifactManifestSchema, entryContent: z.string().max(ARTIFACT_LIMITS.entryBytes), readRef: ArtifactReadRefSchema, workingRevision: hash, workingState: z.enum(['clean', 'dirty', 'writing', 'recovery-required']), pendingOperationId: id.optional() });
const operation = z.object({ pendingOperationId: id.optional(), kind: z.enum(['transaction', 'terminal-capture', 'terminal']).optional(), status: z.enum(['pending', 'committed', 'failed']), result: ArtifactMutationResultSchema.optional(), observedRevision: hash, states: z.array(z.object({ path, hash: hash.nullable(), known: z.boolean() })).max(256), actions: z.array(z.enum(['resume', 'rollback'])).max(2) });
export const ArtifactResponses = {
  artifactCapabilities: z.object({ protocol: z.literal(ARTIFACT_PROTOCOL), formats: z.array(z.enum(['html', 'markdown'])).max(2), snapshot: z.boolean(), restore: z.boolean(), automaticAgents: z.array(z.string().max(64)).max(16), limits: z.object({ files: z.number(), entryBytes: z.number(), resourceBytes: z.number(), versionBytes: z.number(), page: z.number(), chunk: z.number() }) }),
  artifactCatalog: z.array(z.object({ workspaceId: id, root: path, artifacts: z.array(ArtifactSchema), changed: ArtifactChangedSchema.optional() })),
  artifactRegister: ArtifactSchema,
  artifactRead: ArtifactReadResultSchema,
  artifactResourceRead: z.object({ content: z.string().max(Math.ceil(ARTIFACT_LIMITS.chunk / 3) * 4), totalSize: z.number().int().min(0).max(ARTIFACT_LIMITS.resourceBytes), sha256: hash, offset: z.number().int().nonnegative() }),
  artifactVersions: z.object({ versions: z.array(ArtifactVersionSchema).max(30), currentVersionId: id, nextCursor: id.optional() }),
  artifactSave: ArtifactMutationResultSchema,
  artifactRestore: ArtifactMutationResultSchema,
  artifactRename: ArtifactMutationResultSchema,
  artifactOperation: operation,
  artifactResolveOperation: z.object({ status: z.enum(['committed', 'failed']), result: ArtifactMutationResultSchema.optional() }),
} as const;
export const ArtifactRpcErrorSchema = z.object({ code: z.enum(['UNAVAILABLE', 'PERMISSION_DENIED', 'PATH_OUT_OF_BOUNDS', 'NOT_FOUND', 'CONFLICT', 'WRITER_ACTIVE', 'LIMIT_EXCEEDED', 'UNSUPPORTED_PREVIEW', 'INCOMPLETE_VERSION', 'COMMIT_PENDING', 'PARTIAL_COMMIT', 'READ_UNSTABLE', 'INTERNAL']), message: z.string().max(2048), operationId: id.optional(), actualRevision: hash.optional() });
