/**
 * Session Protocol v1 is active. Keep additions optional so older clients can
 * ignore them, preserve event IDs across live delivery and replay, and reserve
 * required breaking changes for Session Protocol v2.
 */

import { createId, isCuid } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionTextEventSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  thinking: z.boolean().optional(),
});

export const sessionServiceMessageEventSchema = z.object({
  t: z.literal('service'),
  text: z.string(),
});

export const mcpAppPresentationV1Schema = z.object({
  version: z.literal(1),
  server: z.string().min(1).max(256),
  resourceUri: z.string().min(6).max(2048).refine((value) => value.startsWith('ui://')),
  appName: z.string().min(1).max(160).optional(),
  actionName: z.string().min(1).max(160).optional(),
});

export type McpAppPresentationV1 = z.infer<typeof mcpAppPresentationV1Schema>;

export const mcpAppResultV1Schema = z.discriminatedUnion('state', [
  z.object({
    version: z.literal(1),
    state: z.literal('available'),
    content: z.array(z.unknown()),
    structuredContent: z.unknown().optional(),
    _meta: z.unknown().optional(),
  }),
  z.object({
    version: z.literal(1),
    state: z.literal('unavailable'),
    code: z.literal('MCP_APP_RESULT_TOO_LARGE'),
  }),
]);

export type McpAppResultV1 = z.infer<typeof mcpAppResultV1Schema>;

export const sessionToolCallStartEventSchema = z.object({
  t: z.literal('tool-call-start'),
  call: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  args: z.record(z.string(), z.unknown()),
  mcpApp: mcpAppPresentationV1Schema.optional(),
});

export const sessionToolCallEndEventSchema = z.object({
  t: z.literal('tool-call-end'),
  call: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']).optional(),
  error: z.object({
    code: z.string().max(64).optional(),
    summary: z.string().min(1).max(280),
    detail: z.string().min(1).max(4000).optional(),
  }).optional(),
  mcpAppResult: mcpAppResultV1Schema.optional(),
});

export const sessionFileEventSchema = z.object({
  t: z.literal('file'),
  ref: z.string(),
  name: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  // 附件语义类型。缺省视为 'image'（兼容历史 file event，那时只有图片）。
  // 'file' 当前用于 E2E 加密的 PDF，并为后续文档格式保留通用语义。
  kind: z.enum(['image', 'audio', 'video', 'file']).optional(),
  // 附件是否 E2E 加密。缺省视为 true（兼容历史图片走整块加密路径）；
  // 音视频走明文流式直传 OSS，发 false，终端据此跳过解密、走流式落盘。
  encrypted: z.boolean().optional(),
  source: z.enum(['user', 'generated', 'browser_step']).optional(),
  // Browser automation frames are delivered through the same encrypted
  // attachment transport, but routed to the dedicated right-side timeline.
  browserStep: z.object({
    label: z.string().min(1),
  }).optional(),
  prompt: z.string().optional(),
  batchId: z.string().optional(),
  localPath: z.string().optional(),
  motionPhoto: z.object({
    videoOffset: z.number().int().nonnegative(),
    videoLength: z.number().int().positive(),
    mimeType: z.literal('video/mp4'),
  }).optional(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string(),
    })
    .optional(),
});

export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
});

export const sessionStartEventSchema = z.object({
  t: z.literal('start'),
  title: z.string().optional(),
});

export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type SessionTurnEndStatus = z.infer<typeof sessionTurnEndStatusSchema>;

export const sessionTurnEndEventSchema = z.object({
  t: z.literal('turn-end'),
  status: sessionTurnEndStatusSchema,
});

export const sessionStopEventSchema = z.object({
  t: z.literal('stop'),
  status: sessionTurnEndStatusSchema.optional(),
});

export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    subagent: z
      .string()
      .refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
      })
      .optional(),
    // Underlying agent-protocol message id (e.g. Claude's `uuid` in the
    // session JSONL). Set on text-bearing envelopes so the app can let
    // users pick a precise rewind point for session fork / duplicate.
    claudeUuid: z.string().min(1).optional(),
    // Codex app-server item id for this envelope. Used as the precise
    // rollback point for Codex thread duplicate/fork-from-message.
    codexItemId: z.string().min(1).optional(),
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service events must use role "agent"',
        path: ['role'],
      });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envelope.ev.t} events must use role "agent"`,
        path: ['role'],
      });
    }
  });

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
  claudeUuid?: string;
  codexItemId?: string;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ...(opts.claudeUuid ? { claudeUuid: opts.claudeUuid } : {}),
    ...(opts.codexItemId ? { codexItemId: opts.codexItemId } : {}),
    ev,
  });
}
