import * as z from "zod";
import { SecurityEventMetadataSchema } from "./security-events.js";

export const AUDIT_ACTOR_TYPES = ["user", "bot", "system"] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/** Small, flat, and content-free, like security event metadata. */
export const AuditEventMetadataSchema = SecurityEventMetadataSchema;
export type AuditEventMetadata = z.infer<typeof AuditEventMetadataSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  organizationId: z.string(),
  spaceId: z.string().nullable(),
  spaceName: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  /** A stable dotted name such as `tool.call` or `credential.deleted`. */
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  outcome: AuditOutcomeSchema,
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: AuditEventMetadataSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEventFilterSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  spaceId: z.string().max(128).optional(),
  actorId: z.string().max(128).optional(),
  action: z.string().max(128).optional(),
});
export type AuditEventFilter = z.infer<typeof AuditEventFilterSchema>;

export const AuditEventListInputSchema = AuditEventFilterSchema.extend({
  /** The id of the last event on the previous page; the next page starts just after it. */
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type AuditEventListInput = z.infer<typeof AuditEventListInputSchema>;

export const AuditEventPageSchema = z.object({
  events: z.array(AuditEventSchema),
  nextCursor: z.string().nullable(),
});
export type AuditEventPage = z.infer<typeof AuditEventPageSchema>;
