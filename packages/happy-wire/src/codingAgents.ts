import { z } from 'zod';
export const CodingAgentIdSchema = z.enum(['codex', 'claude', 'opencode', 'antigravity', 'gemini', 'openclaw']);
// Keep the wire enum readable for stored sessions and responses from older daemons.
// New-session choices and support management use this current product list.
export const supportedCodingAgentIds = ['codex', 'claude', 'opencode', 'antigravity', 'openclaw'] as const satisfies readonly z.infer<typeof CodingAgentIdSchema>[];
export type CodingAgentId = z.infer<typeof CodingAgentIdSchema>;
export const CodingAgentObservationSchema = z.object({
  id: CodingAgentIdSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  executable: z.string().nullable(),
  source: z.enum(['npm', 'native', 'homebrew', 'manual']),
  reason: z.enum(['not-installed', 'manual-update', 'check-failed', 'current', 'update-available']).nullable(),
  updateToken: z.string().uuid().optional(),
}).strict();
export type CodingAgentObservation = z.infer<typeof CodingAgentObservationSchema>;
export const CodingAgentsInspectRequestSchema = z.object({ checkUpdates: z.boolean().default(false), id: CodingAgentIdSchema.optional() }).strict();
export const CodingAgentsInspectResponseSchema = z.object({ agents: z.array(CodingAgentObservationSchema), checkedAt: z.number() }).strict();
export type CodingAgentsInspectResponse = z.infer<typeof CodingAgentsInspectResponseSchema>;
export const CodingAgentUpdateRequestSchema = z.object({ id: CodingAgentIdSchema, updateToken: z.string().uuid() }).strict();
export const CodingAgentUpdateResponseSchema = z.object({
  success: z.boolean(),
  reason: z.enum(['updated', 'stale', 'busy', 'update-failed', 'verify-failed']),
  agent: CodingAgentObservationSchema.optional(),
}).strict();
export type CodingAgentUpdateResponse = z.infer<typeof CodingAgentUpdateResponseSchema>;
