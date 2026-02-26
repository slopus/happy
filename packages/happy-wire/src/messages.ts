import * as z from 'zod';
import { sessionEnvelopeSchema } from './sessionProtocol';
import { MessageMetaSchema, type MessageMeta } from './messageMeta';
import { AgentMessageSchema, UserMessageSchema } from './legacyProtocol';

export const SessionMessageContentSchema = z.object({
  c: z.string(),
  t: z.literal('encrypted'),
});
export type SessionMessageContent = z.infer<typeof SessionMessageContentSchema>;

export const SessionMessageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  localId: z.string().nullish(),
  content: SessionMessageContentSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export { MessageMetaSchema };
export type { MessageMeta };

export const SessionProtocolMessageSchema = z.object({
  role: z.literal('session'),
  content: sessionEnvelopeSchema,
  meta: MessageMetaSchema.optional(),
});
export type SessionProtocolMessage = z.infer<typeof SessionProtocolMessageSchema>;

export const MessageContentSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AgentMessageSchema,
  SessionProtocolMessageSchema,
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

export const VersionedEncryptedValueSchema = z.object({
  version: z.number(),
  value: z.string(),
});
export type VersionedEncryptedValue = z.infer<typeof VersionedEncryptedValueSchema>;

export const VersionedNullableEncryptedValueSchema = z.object({
  version: z.number(),
  value: z.string().nullable(),
});
export type VersionedNullableEncryptedValue = z.infer<typeof VersionedNullableEncryptedValueSchema>;

export const UpdateNewMessageBodySchema = z.object({
  t: z.literal('new-message'),
  sid: z.string(),
  message: SessionMessageSchema,
});
export type UpdateNewMessageBody = z.infer<typeof UpdateNewMessageBodySchema>;

export const UpdateSessionBodySchema = z.object({
  t: z.literal('update-session'),
  id: z.string(),
  metadata: VersionedEncryptedValueSchema.nullish(),
  agentState: VersionedNullableEncryptedValueSchema.nullish(),
});
export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>;

export const VersionedMachineEncryptedValueSchema = z.object({
  version: z.number(),
  value: z.string(),
});
export type VersionedMachineEncryptedValue = z.infer<typeof VersionedMachineEncryptedValueSchema>;

export const UpdateMachineBodySchema = z.object({
  t: z.literal('update-machine'),
  machineId: z.string(),
  metadata: VersionedMachineEncryptedValueSchema.nullish(),
  daemonState: VersionedMachineEncryptedValueSchema.nullish(),
  active: z.boolean().optional(),
  activeAt: z.number().optional(),
});
export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>;

export const CoreUpdateBodySchema = z.discriminatedUnion('t', [
  UpdateNewMessageBodySchema,
  UpdateSessionBodySchema,
  UpdateMachineBodySchema,
]);
export type CoreUpdateBody = z.infer<typeof CoreUpdateBodySchema>;

export const CoreUpdateContainerSchema = z.object({
  id: z.string(),
  seq: z.number(),
  body: CoreUpdateBodySchema,
  createdAt: z.number(),
});
export type CoreUpdateContainer = z.infer<typeof CoreUpdateContainerSchema>;

// Aliases used by existing consumers during migration.
export const ApiMessageSchema = SessionMessageSchema;
export type ApiMessage = SessionMessage;

export const ApiUpdateNewMessageSchema = UpdateNewMessageBodySchema;
export type ApiUpdateNewMessage = UpdateNewMessageBody;

export const ApiUpdateSessionStateSchema = UpdateSessionBodySchema;
export type ApiUpdateSessionState = UpdateSessionBody;

export const ApiUpdateMachineStateSchema = UpdateMachineBodySchema;
export type ApiUpdateMachineState = UpdateMachineBody;

export const UpdateBodySchema = UpdateNewMessageBodySchema;
export type UpdateBody = UpdateNewMessageBody;

export const UpdateSchema = CoreUpdateContainerSchema;
export type Update = CoreUpdateContainer;
