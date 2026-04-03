import { z } from 'zod';

export const SessionIDSchema = z.string();
export type SessionID = z.infer<typeof SessionIDSchema>;

export const MessageIDSchema = z.string();
export type MessageID = z.infer<typeof MessageIDSchema>;

export const SessionInfoSchema = z.object({
  id: SessionIDSchema,
  projectID: z.string(),
  directory: z.string(),
  parentID: SessionIDSchema.optional(),
  title: z.string(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    compacting: z.number().optional(),
  }),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const TodoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']),
});
export type Todo = z.infer<typeof TodoSchema>;

export interface RuntimeConfig {
  source: string;
  permissionMode?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  customSystemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
}
