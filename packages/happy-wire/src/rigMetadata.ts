import * as z from 'zod';

export const RigProviderSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
}).passthrough();

export type RigProvider = z.infer<typeof RigProviderSchema>;

export const RigModelSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  value: z.string(),
  providerId: z.string(),
  providerKind: z.string(),
  providerName: z.string(),
  provider: RigProviderSchema,
  contextWindow: z.number().optional(),
  serviceTiers: z.array(z.string()),
  thinkingLevels: z.array(z.string()),
  defaultThinkingLevel: z.string(),
}).passthrough();

export type RigModel = z.infer<typeof RigModelSchema>;

export const RigOperatingModeKindSchema = z.string();

export type RigOperatingModeKind = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

export const RigOperatingModeSchema = z.object({
  code: z.string(),
  value: z.string(),
  description: z.string(),
  kind: RigOperatingModeKindSchema,
}).passthrough();

type ParsedRigOperatingMode = z.infer<typeof RigOperatingModeSchema>;
export type RigOperatingMode = Omit<ParsedRigOperatingMode, 'kind'> & {
  kind: RigOperatingModeKind;
};

export const RigCapabilitiesSchema = z.object({
  abort: z.boolean(),
  attachments: z.object({
    enabled: z.boolean(),
    maxBytes: z.number(),
    mediaTypes: z.array(z.string()),
  }).passthrough(),
  files: z.object({
    browse: z.boolean(),
    read: z.boolean(),
    search: z.boolean(),
    write: z.boolean(),
  }).passthrough(),
  modelSelection: z.boolean(),
  reasoningSelection: z.boolean(),
  permissionModeSelection: z.boolean(),
  resume: z.boolean(),
  rpcMethods: z.array(z.string()),
  shell: z.boolean(),
  steering: z.boolean(),
}).passthrough();

export const RigActivitySchema = z.object({
  subagents: z.object({
    running: z.number(),
    queued: z.number(),
    total: z.number(),
  }).passthrough(),
  workflows: z.object({
    running: z.number(),
    total: z.number(),
  }).passthrough(),
  processes: z.object({
    running: z.number(),
  }).passthrough(),
  tasks: z.object({
    pending: z.number(),
    inProgress: z.number(),
    completed: z.number(),
    total: z.number(),
  }).passthrough(),
}).passthrough();

export const RigMetadataV1Schema = z.object({
  // Parse later additive revisions with the v1-compatible fields we know.
  rigMetadataVersion: z.number().int().min(1),
  client: z.object({
    id: z.literal('rig'),
    name: z.string(),
    version: z.string(),
  }).passthrough(),
  provider: RigProviderSchema,
  providers: z.array(RigProviderSchema),
  model: z.object({
    providerId: z.string(),
    id: z.string(),
  }).passthrough(),
  models: z.array(RigModelSchema),
  currentModelProviderId: z.string(),
  currentModelCode: z.string(),
  permissionMode: z.string(),
  currentOperatingModeCode: z.string(),
  operatingModes: z.array(RigOperatingModeSchema),
  reasoning: z.object({
    current: z.string().nullable(),
    levels: z.array(z.string()),
  }).passthrough(),
  currentThoughtLevelCode: z.string().optional(),
  thoughtLevels: z.array(z.object({
    code: z.string(),
    value: z.string(),
  }).passthrough()),
  session: z.object({
    status: z.string(),
    permissionMode: z.string(),
    modelLocked: z.boolean(),
    serviceTier: z.string().optional(),
  }).passthrough(),
  capabilities: RigCapabilitiesSchema,
  activity: RigActivitySchema,
  mcpServers: z.array(z.object({
    name: z.string(),
    status: z.string(),
  }).passthrough()),
  tools: z.array(z.string()),
  skills: z.array(z.string()),
}).passthrough();

type ParsedRigMetadata = z.infer<typeof RigMetadataV1Schema>;
export type RigMetadataV1 = Omit<ParsedRigMetadata, 'rigMetadataVersion' | 'operatingModes'> & {
  rigMetadataVersion: 1;
  operatingModes: RigOperatingMode[];
};
