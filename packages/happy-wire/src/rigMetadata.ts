import * as z from 'zod';

/** A bot's identity travels with its single encrypted session. */
export const RigBotSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(512),
  username: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  orderKey: z.string().min(1).max(64),
}).passthrough();

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

/**
 * The selection a message runs with: model, provider, effort, service tier,
 * and permission mode. `lastMode` carries the most recently accepted one.
 */
export const RigMessageModeSchema = z.object({
  effort: z.string(),
  modelId: z.string(),
  permissionMode: z.string(),
  providerId: z.string(),
  serviceTier: z.string().nullable(),
}).passthrough();

export type RigMessageMode = z.infer<typeof RigMessageModeSchema>;

/** The synchronized composer draft; `text` may hold up to 1,000,000 characters. */
export const RigComposerDraftSchema = z.object({
  effort: z.string(),
  modelId: z.string(),
  permissionMode: z.string(),
  providerId: z.string(),
  serviceTier: z.string().nullable(),
  text: z.string(),
}).passthrough();

export type RigComposerDraft = z.infer<typeof RigComposerDraftSchema>;

export const RigMetadataV1Schema = z.object({
  bot: RigBotSchema.optional(),
  // Parse later additive revisions with the v1-compatible fields we know.
  rigMetadataVersion: z.number().int().min(1),
  client: z.object({
    id: z.literal('rig'),
    name: z.string(),
    version: z.string(),
  }).passthrough(),
  providers: z.array(RigProviderSchema),
  models: z.array(RigModelSchema),
  operatingModes: z.array(RigOperatingModeSchema),
  // The composer state current daemons synchronize. `draft: null` is a cleared
  // draft that keeps its timestamp; all three are absent from older daemons.
  draft: RigComposerDraftSchema.nullish(),
  draftUpdatedAt: z.number().int().min(0).nullish(),
  lastMode: RigMessageModeSchema.nullish(),
  // Deprecated read-only mirrors of the effective selection. Still published
  // for older phone builds, but scheduled for removal once every client reads
  // the composer fields above, so the parser no longer requires them.
  provider: RigProviderSchema.optional(),
  currentModelProviderId: z.string().optional(),
  currentModelCode: z.string().optional(),
  permissionMode: z.string().optional(),
  currentOperatingModeCode: z.string().optional(),
  currentThoughtLevelCode: z.string().optional(),
  // No longer published by current daemons; kept optional so their older
  // payloads still parse.
  model: z.object({
    providerId: z.string(),
    id: z.string(),
  }).passthrough().optional(),
  reasoning: z.object({
    current: z.string().nullable(),
    levels: z.array(z.string()),
  }).passthrough().optional(),
  thoughtLevels: z.array(z.object({
    code: z.string(),
    value: z.string(),
  }).passthrough()).optional(),
  activity: RigActivitySchema.optional(),
  mcpServers: z.array(z.object({
    name: z.string(),
    status: z.string(),
  }).passthrough()).optional(),
  skills: z.array(z.string()).optional(),
  session: z.object({
    status: z.string(),
    // Deprecated mirror; see the composer fields above.
    permissionMode: z.string().optional(),
    modelLocked: z.boolean(),
    serviceTier: z.string().optional(),
  }).passthrough(),
  capabilities: RigCapabilitiesSchema,
  tools: z.array(z.string()),
}).passthrough();

type ParsedRigMetadata = z.infer<typeof RigMetadataV1Schema>;
export type RigMetadataV1 = Omit<ParsedRigMetadata, 'rigMetadataVersion' | 'operatingModes'> & {
  rigMetadataVersion: 1;
  operatingModes: RigOperatingMode[];
};
