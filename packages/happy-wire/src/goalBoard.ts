import { z } from 'zod';

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
});
export type GoalArtifact = z.infer<typeof GoalArtifactSchema>;
export const GoalTaskSchema = z.object({
    id: label, code: label.optional(), title: label, indexPath: path, promptPath: path.optional(),
    status: GoalTaskStatusSchema, goal: label, problem: label.optional(), stage: label.optional(),
    progress: label.optional(), nextStep: label.optional(), dependencies: z.array(label).max(30),
    expectedDeliverables: z.array(label).max(30), artifacts: z.array(GoalArtifactSchema).max(50), batch: label.optional(),
});
export type GoalTask = z.infer<typeof GoalTaskSchema>;
export const GoalBoardSnapshotSchema = z.object({
    featurePath: path, title: label, projectTitle: label.optional(), revision: label, updatedAt: z.number(),
    tasks: z.array(GoalTaskSchema).max(200), warnings: z.array(label).max(50),
});
export type GoalBoardSnapshot = z.infer<typeof GoalBoardSnapshotSchema>;
export const GoalBoardCatalogEntrySchema = z.object({ featurePath: path, title: label, projectTitle: label.optional() });
export type GoalBoardCatalogEntry = z.infer<typeof GoalBoardCatalogEntrySchema>;
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
