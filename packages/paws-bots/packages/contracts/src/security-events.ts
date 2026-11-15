import * as z from "zod";

/** Every security event the backend records. Alert queries match these strings. */
export const SECURITY_EVENT_TYPES = [
  "auth.sign_up",
  "auth.sign_up.failed",
  "auth.sign_in",
  "auth.sign_in.failed",
  "auth.sign_out",
  "auth.session.revoked",
  "auth.password.changed",
  "auth.passkey.added",
  "auth.passkey.changed",
  "auth.passkey.removed",
  "auth.account.deleted",
  "auth.account.deactivated",
  "auth.account.reactivated",
  "auth.identity.confirmed",
  "credential.created",
  "credential.changed",
  "credential.deleted",
  "credential.revealed",
  "device.paired",
  "device.tied",
  "device.revoked",
  "deployment.settings.changed",
  "approval.decided",
  "approval.policy.changed",
  "bot_email.policy.changed",
  "space.invite.created",
  "space.invites.cancelled",
  "space.member.joined",
  "space.member.removed",
  "space.member.left",
  "egress.refused",
  "rate_limit.hit",
] as const;

export const SecurityEventTypeSchema = z.enum(SECURITY_EVENT_TYPES);
export type SecurityEventType = z.infer<typeof SecurityEventTypeSchema>;

/** Small, flat, and content-free: identifiers, kinds, and outcomes only. */
export const SecurityEventMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type SecurityEventMetadata = z.infer<typeof SecurityEventMetadataSchema>;

export const SecurityEventSchema = z.object({
  id: z.string(),
  type: SecurityEventTypeSchema,
  userId: z.string().nullable(),
  spaceId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: SecurityEventMetadataSchema,
  createdAt: z.string(),
});
export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

export const SecurityEventListInputSchema = z.object({
  type: SecurityEventTypeSchema.optional(),
  ip: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  /** The id of the last event on the previous page; the next page starts just after it. */
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
