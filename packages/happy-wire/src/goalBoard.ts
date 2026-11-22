import { z } from 'zod';
import { GoalReviewSchema } from './goalReview';

// Keep encrypted RPC frames below Socket.IO's 1 MB default. Larger originals
// use the existing authenticated, encrypted HTTP attachment lane.
export const GOAL_ARTIFACT_MAX_INLINE_TEXT_BYTES = 64 * 1024;
export const GOAL_ARTIFACT_MAX_TEXT_BYTES = 16 * 1024 * 1024;

const label = z.string().max(2048);
const path = z.string().max(8192);
export const GoalTaskStatusSchema = z.enum(['pending', 'running', 'review', 'done', 'blocked', 'unknown']).catch('unknown');
export type GoalTaskStatus = z.infer<typeof GoalTaskStatusSchema>;
export const GoalArtifactKindSchema = z.enum(['text', 'image', 'audio', 'video', 'pdf', 'commit', 'url', 'unsupported']);
export type GoalArtifactKind = z.infer<typeof GoalArtifactKindSchema>;
export const GoalArtifactSchema = z.object({
    id: label, kind: GoalArtifactKindSchema, name: label, path: path.optional(), url: path.optional(),
    description: label.optional(), relation: z.enum(['output', 'reference']),
    size: z.number().nonnegative().optional(), modifiedAt: z.number().nonnegative().optional(), available: z.boolean(),
    revision: z.string().max(128).optional(),
    approval: z.object({ status: z.enum(['unreviewed', 'accepted', 'changed']), reviewedAt: z.number().optional() }).optional(),
});
export type GoalArtifact = z.infer<typeof GoalArtifactSchema>;
export const GoalTaskSchema = z.object({
    id: label, legacyIds: z.array(label).max(32).optional(), code: label.optional(), title: label, indexPath: path, promptPath: path.optional(),
    status: GoalTaskStatusSchema, goal: label, problem: label.optional(), stage: label.optional(),
    progress: label.optional(), nextStep: label.optional(), dependencies: z.array(label).max(30),
    expectedDeliverables: z.array(label).max(30), artifacts: z.array(GoalArtifactSchema).max(50), batch: label.optional(),
    acceptanceCriteria: z.array(label).max(30).optional(),
    review: GoalReviewSchema.optional(),
    execution: z.object({ state: z.enum(['never', 'starting', 'submitted', 'historical', 'uncertain']), sessionId: label.optional() }).optional(),
});
export type GoalTask = z.infer<typeof GoalTaskSchema>;
export const GoalBoardSnapshotSchema = z.object({
    featurePath: path, title: label, projectTitle: label.optional(), revision: label, updatedAt: z.number(),
    tasks: z.array(GoalTaskSchema).max(200), ambiguousTaskIds: z.array(label).max(200).optional(), warnings: z.array(label).max(50),
});
export type GoalBoardSnapshot = z.infer<typeof GoalBoardSnapshotSchema>;
export const GoalBoardCatalogEntrySchema = z.object({ featurePath: path, title: label, summary: label.optional(), projectTitle: label.optional(), projectPath: path.optional() });
export type GoalBoardCatalogEntry = z.infer<typeof GoalBoardCatalogEntrySchema>;
/** Public GitHub repository location, never credentials, query strings or arbitrary URLs. */
export const GoalGithubUrlSchema = z.string().max(2048)
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/?$/)
    .refine(value => !['.', '..', '.git'].includes(value.replace(/\/$/, '').split('/').pop()!), 'Expected a GitHub repository');
export const GoalProjectSchema = z.object({
    projectPath: path, title: label, summary: label.optional(), features: z.array(GoalBoardCatalogEntrySchema).max(100),
    direct: GoalBoardCatalogEntrySchema.optional(), githubUrl: GoalGithubUrlSchema.optional().catch(undefined),
});
export type GoalProject = z.infer<typeof GoalProjectSchema>;
export const GoalTaskSessionSchema = z.object({
    sessionId: label, title: label, directory: path, updatedAt: z.number(), executed: z.boolean(), active: z.boolean().optional(), lifecycleState: z.string().max(64).optional(),
});
export type GoalTaskSession = z.infer<typeof GoalTaskSessionSchema>;
/** Compact metadata supplied only by the authenticated owner's fully read catalog.
 * Session/account existence and metadataVersion are verified again by the daemon. */
export const GoalProjectConversationCandidateSchema = z.object({
    sessionId: label, metadataVersion: z.number().int().nonnegative(), directory: path, title: label,
    featurePath: path.optional(), taskId: label.optional(), lifecycleState: z.string().max(64).optional(),
}).refine(value => !value.taskId || !!value.featurePath, 'A task candidate needs its feature path');
export type GoalProjectConversationCandidate = z.infer<typeof GoalProjectConversationCandidateSchema>;
/** Complete group totals accompany bounded, independently paginated session headers. */
export const GoalProjectConversationSchema = GoalTaskSessionSchema.extend({ taskId: label.optional() });
export type GoalProjectConversation = z.infer<typeof GoalProjectConversationSchema>;
export const GoalProjectConversationGroupSchema = z.object({
    scopePath: path, title: label, total: z.number().int().nonnegative(),
    sessions: z.array(GoalProjectConversationSchema).max(25),
    nextCursor: z.object({ updatedAt: z.number(), sessionId: label }).optional(),
});
export type GoalProjectConversationGroup = z.infer<typeof GoalProjectConversationGroupSchema>;
export const GoalProjectConversationsSchema = z.object({
    success: z.literal(true), projectPath: path, groups: z.array(GoalProjectConversationGroupSchema).max(101),
});
export type GoalProjectConversations = z.infer<typeof GoalProjectConversationsSchema>;
export const GoalBoardBindingSchema = z.object({ featurePath: path, taskId: label.optional(), parentSessionId: label.optional() });
export type GoalBoardBinding = z.infer<typeof GoalBoardBindingSchema>;
export const GoalBoardAttachmentSchema = z.object({
    ref: path.min(1), name: label.min(1), size: z.number().int().nonnegative().max(500 * 1024 * 1024), mimeType: z.string().max(256).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
    kind: z.enum(['image', 'audio', 'video', 'file']), encrypted: z.boolean(),
});
export type GoalBoardAttachment = z.infer<typeof GoalBoardAttachmentSchema>;
export const GoalBoardArtifactResponseSchema = z.union([
    z.object({ success: z.literal(false), error: label }),
    z.object({ success: z.literal(true), kind: z.literal('text'), content: z.string().max(2 * 1024 * 1024), revision: label, name: label }),
    z.object({ success: z.literal(true), kind: z.literal('attachment'), attachment: GoalBoardAttachmentSchema }),
]);
export type GoalBoardArtifactResponse = z.infer<typeof GoalBoardArtifactResponseSchema>;

/** The selected project/feature archive, never an account-wide aggregation. */
export const GoalScopeOverviewSchema = z.object({
    scopePath: path, indexPath: path, title: label, goal: label,
    fileCount: z.number().int().nonnegative(), countComplete: z.boolean(), revision: label,
});
export type GoalScopeOverview = z.infer<typeof GoalScopeOverviewSchema>;
