import { z } from 'zod';

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(),
    permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional()
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;