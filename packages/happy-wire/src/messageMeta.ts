import * as z from 'zod';

export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  // Native clients may publish their own mode codes (for example Rig's
  // auto/workspace_write/read_only/full_access), so this stays open-ended.
  permissionMode: z.string().optional(),
  model: z.string().nullable().optional(),
  modelProviderId: z.string().optional(),
  fallbackModel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  effort: z.string().nullable().optional(),
  displayText: z.string().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;
