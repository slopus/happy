import * as z from 'zod';
import { MessageMetaSchema } from './messageMeta';

export const ImageAttachmentSchema = z.object({
  base64: z.string(),
  mediaType: z.string(),
});

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string(),
    images: z.array(ImageAttachmentSchema).optional(),
  }),
  localKey: z.string().optional(),
  meta: MessageMetaSchema.optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z
    .object({
      type: z.string(),
    })
    .passthrough(),
  meta: MessageMetaSchema.optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const LegacyMessageContentSchema = z.discriminatedUnion('role', [UserMessageSchema, AgentMessageSchema]);
export type LegacyMessageContent = z.infer<typeof LegacyMessageContentSchema>;
