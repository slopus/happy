/**
 * Messaging Protocol v3 — Message + Parts model
 *
 * Adopted from OpenCode's transcript shape with Happy-specific adaptations:
 * - `blocked` tool state for permissions and questions (not side-channel)
 * - Patchable canonical messages (not delta replay)
 * - Shared types imported by both CLI (producer) and app (consumer)
 *
 * See docs/plans/provider-envelope-redesign.md for full design rationale.
 */

import { z } from 'zod';
import { MessageMetaSchema } from './messageMeta';

// ─── IDs ──────────────────────────────────────────────────────────────────────

/** Prefixed ascending IDs for messages, parts, permissions, questions */
export const MessageID = z.string().brand('MessageID');
export type MessageID = z.infer<typeof MessageID>;

export const PartID = z.string().brand('PartID');
export type PartID = z.infer<typeof PartID>;

export const SessionID = z.string().brand('SessionID');
export type SessionID = z.infer<typeof SessionID>;

// ─── Output format ────────────────────────────────────────────────────────────

export const OutputFormatTextSchema = z.object({ type: z.literal('text') });
export const OutputFormatJsonSchema = z.object({
  type: z.literal('json_schema'),
  schema: z.record(z.string(), z.any()),
  retryCount: z.number().int().min(0).optional(),
});
export const OutputFormatSchema = z.discriminatedUnion('type', [
  OutputFormatTextSchema,
  OutputFormatJsonSchema,
]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

// ─── FileDiff ─────────────────────────────────────────────────────────────────

export const FileDiffSchema = z.object({
  file: z.string(),
  relativePath: z.string().optional(),
  type: z.enum(['add', 'modify', 'delete']).optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

// ─── Errors ───────────────────────────────────────────────────────────────────

export const MessageErrorSchema = z.object({
  name: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type MessageError = z.infer<typeof MessageErrorSchema>;

// ─── User Message ─────────────────────────────────────────────────────────────

export const UserMessageSchema = z.object({
  id: MessageID,
  sessionID: SessionID,
  role: z.literal('user'),
  time: z.object({ created: z.number() }),
  agent: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
  }),
  format: OutputFormatSchema.optional(),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  meta: MessageMetaSchema.optional(),
  variant: z.string().optional(),
  summary: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    diffs: z.array(FileDiffSchema),
  }).optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

// ─── Assistant Message ────────────────────────────────────────────────────────

export const AssistantMessageSchema = z.object({
  id: MessageID,
  sessionID: SessionID,
  role: z.literal('assistant'),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }),
  parentID: MessageID,
  modelID: z.string(),
  providerID: z.string(),
  agent: z.string(),
  path: z.object({
    cwd: z.string(),
    root: z.string(),
  }),
  cost: z.number(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
  finish: z.string().optional(),
  error: MessageErrorSchema.optional(),
  summary: z.boolean().optional(),
  variant: z.string().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

// ─── Message (discriminated union) ────────────────────────────────────────────

export const MessageInfoSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
]);
export type MessageInfo = z.infer<typeof MessageInfoSchema>;

// ─── Part base ────────────────────────────────────────────────────────────────

export const PartBaseSchema = z.object({
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
});

// ─── TextPart ─────────────────────────────────────────────────────────────────

export const TextPartSchema = PartBaseSchema.extend({
  type: z.literal('text'),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z.object({
    start: z.number(),
    end: z.number().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

// ─── ReasoningPart ────────────────────────────────────────────────────────────

export const ReasoningPartSchema = PartBaseSchema.extend({
  type: z.literal('reasoning'),
  text: z.string(),
  time: z.object({
    start: z.number(),
    end: z.number().optional(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;

// ─── FilePartSource ───────────────────────────────────────────────────────────

export const FileSourceSchema = z.object({
  type: z.literal('file'),
  path: z.string(),
  text: z.object({
    value: z.string(),
    start: z.number().int(),
    end: z.number().int(),
  }).optional(),
});

export const SymbolSourceSchema = z.object({
  type: z.literal('symbol'),
  path: z.string(),
  name: z.string(),
  kind: z.number().int(),
  range: z.object({
    start: z.object({ line: z.number().int(), character: z.number().int() }),
    end: z.object({ line: z.number().int(), character: z.number().int() }),
  }),
  text: z.object({
    value: z.string(),
    start: z.number().int(),
    end: z.number().int(),
  }).optional(),
});

export const ResourceSourceSchema = z.object({
  type: z.literal('resource'),
  clientName: z.string(),
  uri: z.string(),
  text: z.object({
    value: z.string(),
    start: z.number().int(),
    end: z.number().int(),
  }).optional(),
});

export const FilePartSourceSchema = z.discriminatedUnion('type', [
  FileSourceSchema,
  SymbolSourceSchema,
  ResourceSourceSchema,
]);
export type FilePartSource = z.infer<typeof FilePartSourceSchema>;

// ─── FilePart ─────────────────────────────────────────────────────────────────

export const FilePartSchema = PartBaseSchema.extend({
  type: z.literal('file'),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  source: FilePartSourceSchema.optional(),
});
export type FilePart = z.infer<typeof FilePartSchema>;

// ─── Block types (permissions + questions) ────────────────────────────────────

export const PermissionBlockSchema = z.object({
  type: z.literal('permission'),
  id: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()),
  always: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
});
export type PermissionBlock = z.infer<typeof PermissionBlockSchema>;

export const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

export const QuestionInfoSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(QuestionOptionSchema),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
});
export type QuestionInfo = z.infer<typeof QuestionInfoSchema>;

export const QuestionBlockSchema = z.object({
  type: z.literal('question'),
  id: z.string(),
  questions: z.array(QuestionInfoSchema),
});
export type QuestionBlock = z.infer<typeof QuestionBlockSchema>;

export const BlockSchema = z.discriminatedUnion('type', [
  PermissionBlockSchema,
  QuestionBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;

// Resolved variants (after user responds)

export const ResolvedPermissionBlockSchema = PermissionBlockSchema.extend({
  decision: z.enum(['once', 'always', 'reject']),
  decidedAt: z.number(),
});
export type ResolvedPermissionBlock = z.infer<typeof ResolvedPermissionBlockSchema>;

export const ResolvedQuestionBlockSchema = QuestionBlockSchema.extend({
  answers: z.array(z.array(z.string())),
  decidedAt: z.number(),
});
export type ResolvedQuestionBlock = z.infer<typeof ResolvedQuestionBlockSchema>;

export const ResolvedBlockSchema = z.discriminatedUnion('type', [
  ResolvedPermissionBlockSchema,
  ResolvedQuestionBlockSchema,
]);
export type ResolvedBlock = z.infer<typeof ResolvedBlockSchema>;

// ─── Tool state machine ──────────────────────────────────────────────────────

export const ToolStatePendingSchema = z.object({
  status: z.literal('pending'),
  input: z.record(z.string(), z.unknown()),
  raw: z.string(),
});
export type ToolStatePending = z.infer<typeof ToolStatePendingSchema>;

export const ToolStateRunningSchema = z.object({
  status: z.literal('running'),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: z.object({ start: z.number() }),
});
export type ToolStateRunning = z.infer<typeof ToolStateRunningSchema>;

export const ToolStateBlockedSchema = z.object({
  status: z.literal('blocked'),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: z.object({ start: z.number() }),
  block: BlockSchema,
});
export type ToolStateBlocked = z.infer<typeof ToolStateBlockedSchema>;

export const ToolStateCompletedSchema = z.object({
  status: z.literal('completed'),
  input: z.record(z.string(), z.unknown()),
  output: z.string(),
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  time: z.object({
    start: z.number(),
    end: z.number(),
    compacted: z.number().optional(),
  }),
  attachments: z.array(FilePartSchema).optional(),
  block: ResolvedBlockSchema.optional(),
});
export type ToolStateCompleted = z.infer<typeof ToolStateCompletedSchema>;

export const ToolStateErrorSchema = z.object({
  status: z.literal('error'),
  input: z.record(z.string(), z.unknown()),
  error: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: z.object({
    start: z.number(),
    end: z.number(),
  }),
  block: ResolvedBlockSchema.optional(),
});
export type ToolStateError = z.infer<typeof ToolStateErrorSchema>;

export const ToolStateSchema = z.discriminatedUnion('status', [
  ToolStatePendingSchema,
  ToolStateRunningSchema,
  ToolStateBlockedSchema,
  ToolStateCompletedSchema,
  ToolStateErrorSchema,
]);
export type ToolState = z.infer<typeof ToolStateSchema>;

// ─── ToolPart ─────────────────────────────────────────────────────────────────

export const ToolPartSchema = PartBaseSchema.extend({
  type: z.literal('tool'),
  callID: z.string(),
  tool: z.string(),
  state: ToolStateSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ToolPart = z.infer<typeof ToolPartSchema>;

// ─── Step lifecycle parts ─────────────────────────────────────────────────────

export const StepStartPartSchema = PartBaseSchema.extend({
  type: z.literal('step-start'),
  snapshot: z.string().optional(),
});
export type StepStartPart = z.infer<typeof StepStartPartSchema>;

export const StepFinishPartSchema = PartBaseSchema.extend({
  type: z.literal('step-finish'),
  reason: z.string(),
  snapshot: z.string().optional(),
  cost: z.number(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
});
export type StepFinishPart = z.infer<typeof StepFinishPartSchema>;

// ─── Subagent parts ───────────────────────────────────────────────────────────

export const SubtaskPartSchema = PartBaseSchema.extend({
  type: z.literal('subtask'),
  prompt: z.string(),
  description: z.string(),
  agent: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
  }).optional(),
  command: z.string().optional(),
});
export type SubtaskPart = z.infer<typeof SubtaskPartSchema>;

export const AgentPartSchema = PartBaseSchema.extend({
  type: z.literal('agent'),
  name: z.string(),
});
export type AgentPart = z.infer<typeof AgentPartSchema>;

// ─── Snapshot / Patch ─────────────────────────────────────────────────────────

export const SnapshotPartSchema = PartBaseSchema.extend({
  type: z.literal('snapshot'),
  snapshot: z.string(),
});
export type SnapshotPart = z.infer<typeof SnapshotPartSchema>;

export const PatchPartSchema = PartBaseSchema.extend({
  type: z.literal('patch'),
  hash: z.string(),
  files: z.array(z.string()),
});
export type PatchPart = z.infer<typeof PatchPartSchema>;

// ─── Compaction ───────────────────────────────────────────────────────────────

export const CompactionPartSchema = PartBaseSchema.extend({
  type: z.literal('compaction'),
  auto: z.boolean(),
  overflow: z.boolean().optional(),
});
export type CompactionPart = z.infer<typeof CompactionPartSchema>;

// ─── Retry ────────────────────────────────────────────────────────────────────

export const RetryPartSchema = PartBaseSchema.extend({
  type: z.literal('retry'),
  attempt: z.number(),
  error: MessageErrorSchema,
  time: z.object({ created: z.number() }),
});
export type RetryPart = z.infer<typeof RetryPartSchema>;

// ─── Decision part (permission resolution) ───────────────────────────────────

export const DecisionPartSchema = PartBaseSchema.extend({
  type: z.literal('decision'),
  targetMessageID: MessageID,
  targetCallID: z.string(),
  permissionID: z.string(),
  decision: z.enum(['once', 'always', 'reject']),
  allowTools: z.array(z.string()).optional(),
  reason: z.string().optional(),
  decidedAt: z.number(),
});
export type DecisionPart = z.infer<typeof DecisionPartSchema>;

// ─── Answer part (question resolution) ───────────────────────────────────────

export const AnswerPartSchema = PartBaseSchema.extend({
  type: z.literal('answer'),
  targetMessageID: MessageID,
  targetCallID: z.string(),
  questionID: z.string(),
  answers: z.array(z.array(z.string())),
  decidedAt: z.number(),
});
export type AnswerPart = z.infer<typeof AnswerPartSchema>;

// ─── Part (discriminated union) ───────────────────────────────────────────────

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  FilePartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  SubtaskPartSchema,
  AgentPartSchema,
  SnapshotPartSchema,
  PatchPartSchema,
  CompactionPartSchema,
  RetryPartSchema,
  DecisionPartSchema,
  AnswerPartSchema,
]);
export type Part = z.infer<typeof PartSchema>;

// ─── Message with parts (the canonical record) ───────────────────────────────

export const MessageWithPartsSchema = z.object({
  info: MessageInfoSchema,
  parts: z.array(PartSchema),
});
export type MessageWithParts = z.infer<typeof MessageWithPartsSchema>;

// ─── Flat session control messages ──────────────────────────────────────────

export const RuntimeConfigPayloadSchema = MessageMetaSchema.pick({
  permissionMode: true,
  model: true,
  fallbackModel: true,
  customSystemPrompt: true,
  appendSystemPrompt: true,
  allowedTools: true,
  disallowedTools: true,
});
export type RuntimeConfigPayload = z.infer<typeof RuntimeConfigPayloadSchema>;

export const RuntimeConfigChangeSchema = z.object({
  type: z.literal('runtime-config-change'),
  id: MessageID,
  sessionID: SessionID,
  time: z.object({ created: z.number() }),
  source: z.enum(['user', 'agent']),
}).merge(RuntimeConfigPayloadSchema);
export type RuntimeConfigChange = z.infer<typeof RuntimeConfigChangeSchema>;

export const AbortRequestSchema = z.object({
  type: z.literal('abort-request'),
  id: MessageID,
  sessionID: SessionID,
  time: z.object({ created: z.number() }),
  source: z.enum(['user', 'system']),
  reason: z.string().optional(),
});
export type AbortRequest = z.infer<typeof AbortRequestSchema>;

export const SessionEndSchema = z.object({
  type: z.literal('session-end'),
  id: MessageID,
  sessionID: SessionID,
  time: z.object({ created: z.number() }),
  reason: z.enum(['completed', 'archived', 'killed', 'crashed']),
  archivedBy: z.string().optional(),
});
export type SessionEnd = z.infer<typeof SessionEndSchema>;

export const PermissionRequestMessageSchema = z.object({
  type: z.literal('permission-request'),
  id: MessageID,
  sessionID: SessionID,
  time: z.object({ created: z.number() }),
  callID: z.string(),
  tool: z.string(),
  patterns: z.array(z.string()),
  input: z.record(z.string(), z.unknown()),
});
export type PermissionRequestMessage = z.infer<typeof PermissionRequestMessageSchema>;

export const PermissionResponseMessageSchema = z.object({
  type: z.literal('permission-response'),
  id: MessageID,
  sessionID: SessionID,
  time: z.object({ created: z.number() }),
  requestID: MessageID,
  callID: z.string(),
  decision: z.enum(['once', 'always', 'reject']),
  allowTools: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type PermissionResponseMessage = z.infer<typeof PermissionResponseMessageSchema>;

export const SessionControlMessageSchema = z.union([
  RuntimeConfigChangeSchema,
  AbortRequestSchema,
  SessionEndSchema,
  PermissionRequestMessageSchema,
  PermissionResponseMessageSchema,
]);
export type SessionControlMessage = z.infer<typeof SessionControlMessageSchema>;

export const SessionStreamMessageSchema = z.union([
  MessageWithPartsSchema,
  SessionControlMessageSchema,
]);
export type SessionStreamMessage = z.infer<typeof SessionStreamMessageSchema>;

// ─── Permission rules ─────────────────────────────────────────────────────────

export const PermissionActionSchema = z.enum(['allow', 'deny', 'ask']);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

export const PermissionRuleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: PermissionActionSchema,
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const PermissionRulesetSchema = z.array(PermissionRuleSchema);
export type PermissionRuleset = z.infer<typeof PermissionRulesetSchema>;

// ─── Todo ─────────────────────────────────────────────────────────────────────

export const TodoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']),
});
export type Todo = z.infer<typeof TodoSchema>;

// ─── Session ──────────────────────────────────────────────────────────────────

export const SessionInfoSchema = z.object({
  id: SessionID,
  projectID: z.string(),
  directory: z.string(),
  parentID: SessionID.optional(),
  title: z.string(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    compacting: z.number().optional(),
  }),
  permission: PermissionRulesetSchema.optional(),
  summary: z.object({
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
    diffs: z.array(FileDiffSchema).optional(),
  }).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// ─── Protocol version marker ──────────────────────────────────────────────────

/**
 * Wraps a canonical message for transport. The `v` field lets the receiver
 * distinguish v3 messages+parts from legacy payloads.
 */
export const ProtocolEnvelopeSchema = z.object({
  v: z.literal(3),
  message: SessionStreamMessageSchema,
});
export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>;

export function isMessageWithParts(message: SessionStreamMessage): message is MessageWithParts {
  return 'info' in message && 'parts' in message;
}

export function isSessionControlMessage(message: SessionStreamMessage): message is SessionControlMessage {
  return 'type' in message;
}
