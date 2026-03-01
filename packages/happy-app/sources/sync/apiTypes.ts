import { z } from 'zod';
import { GitHubProfileSchema, ImageRefSchema } from './profile';
import { RelationshipStatusSchema, UserProfileSchema } from './friendTypes';
import { FeedBodySchema } from './feedTypes';

//
// Encrypted message
//

export const ApiMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    localId: z.string().nullish(),
    content: z.object({
        t: z.literal('encrypted'),
        c: z.string(), // Base64 encoded encrypted content
    }),
    createdAt: z.number(),
});

export type ApiMessage = z.infer<typeof ApiMessageSchema>;

//
// Updates
//

export const ApiUpdateNewMessageSchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(), // Session ID
    message: ApiMessageSchema
});

export const ApiUpdateNewSessionSchema = z.object({
    t: z.literal('new-session'),
    id: z.string(), // Session ID
    createdAt: z.number(),
    updatedAt: z.number(),
});

export const ApiDeleteSessionSchema = z.object({
    t: z.literal('delete-session'),
    sid: z.string(), // Session ID
});

export const ApiUpdateSessionStateSchema = z.object({
    t: z.literal('update-session'),
    id: z.string(),
    agentState: z.object({
        version: z.number(),
        value: z.string()
    }).nullish(),
    metadata: z.object({
        version: z.number(),
        value: z.string()
    }).nullish(),
});

export const ApiUpdateAccountSchema = z.object({
    t: z.literal('update-account'),
    id: z.string(),
    settings: z.object({
        value: z.string().nullish(),
        version: z.number()
    }).nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    avatar: ImageRefSchema.nullish(),
    github: GitHubProfileSchema.nullish(),
});

export const ApiNewMachineSchema = z.object({
    t: z.literal('new-machine'),
    machineId: z.string(),
});

export const ApiUpdateMachineStateSchema = z.object({
    t: z.literal('update-machine'),
    machineId: z.string(),  // Changed from 'id' to 'machineId' for clarity
    metadata: z.object({
        version: z.number(),
        value: z.string() // Encrypted, client decrypts
    }).nullish(),
    daemonState: z.object({
        version: z.number(),
        value: z.string() // Encrypted, client decrypts
    }).nullish(),
    active: z.boolean().optional(),
    activeAt: z.number().optional()
});

// Artifact update schemas
export const ApiNewArtifactSchema = z.object({
    t: z.literal('new-artifact'),
    artifactId: z.string(),
    header: z.string(),
    headerVersion: z.number(),
    body: z.string().optional(),
    bodyVersion: z.number().optional(),
    dataEncryptionKey: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number()
});

export const ApiUpdateArtifactSchema = z.object({
    t: z.literal('update-artifact'),
    artifactId: z.string(),
    header: z.object({
        value: z.string(),
        version: z.number()
    }).optional(),
    body: z.object({
        value: z.string(),
        version: z.number()
    }).optional()
});

export const ApiDeleteArtifactSchema = z.object({
    t: z.literal('delete-artifact'),
    artifactId: z.string()
});

// Relationship update schema
export const ApiRelationshipUpdatedSchema = z.object({
    t: z.literal('relationship-updated'),
    fromUserId: z.string(),
    toUserId: z.string(),
    status: RelationshipStatusSchema,
    action: z.enum(['created', 'updated', 'deleted']),
    fromUser: UserProfileSchema.optional(),
    toUser: UserProfileSchema.optional(),
    timestamp: z.number()
});

// Feed update schema
export const ApiNewFeedPostSchema = z.object({
    t: z.literal('new-feed-post'),
    id: z.string(),
    body: FeedBodySchema,
    cursor: z.string(),
    createdAt: z.number(),
    repeatKey: z.string().nullable()
});

// KV batch update schema - kept for protocol compatibility (server may still emit these)
export const ApiKvBatchUpdateSchema = z.object({
    t: z.literal('kv-batch-update'),
    changes: z.array(z.object({
        key: z.string(),
        value: z.string().nullable(),
        version: z.number()
    }))
});

// OpenClaw machine update schemas
export const ApiNewOpenClawMachineSchema = z.object({
    t: z.literal('new-openclaw-machine'),
    machineId: z.string(),
    machineType: z.enum(['happy', 'direct']),
    happyMachineId: z.string().nullable(),
    directConfig: z.string().nullable(),
    metadata: z.string(),
    metadataVersion: z.number(),
    pairingData: z.string().nullable(),
    dataEncryptionKey: z.string().nullable(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number()
});

export const ApiUpdateOpenClawMachineSchema = z.object({
    t: z.literal('update-openclaw-machine'),
    machineId: z.string(),
    metadata: z.object({
        value: z.string(),
        version: z.number()
    }).optional(),
    pairingData: z.string().nullable().optional(),
    directConfig: z.string().nullable().optional()
});

export const ApiDeleteOpenClawMachineSchema = z.object({
    t: z.literal('delete-openclaw-machine'),
    machineId: z.string()
});

export const ApiUpdateSchema = z.discriminatedUnion('t', [
    ApiUpdateNewMessageSchema,
    ApiUpdateNewSessionSchema,
    ApiDeleteSessionSchema,
    ApiUpdateSessionStateSchema,
    ApiUpdateAccountSchema,
    ApiNewMachineSchema,
    ApiUpdateMachineStateSchema,
    ApiNewArtifactSchema,
    ApiUpdateArtifactSchema,
    ApiDeleteArtifactSchema,
    ApiRelationshipUpdatedSchema,
    ApiNewFeedPostSchema,
    ApiKvBatchUpdateSchema,
    ApiNewOpenClawMachineSchema,
    ApiUpdateOpenClawMachineSchema,
    ApiDeleteOpenClawMachineSchema
]);

export type ApiUpdateNewMessage = z.infer<typeof ApiUpdateNewMessageSchema>;
export type ApiRelationshipUpdated = z.infer<typeof ApiRelationshipUpdatedSchema>;
export type ApiNewOpenClawMachine = z.infer<typeof ApiNewOpenClawMachineSchema>;
export type ApiUpdateOpenClawMachine = z.infer<typeof ApiUpdateOpenClawMachineSchema>;
export type ApiDeleteOpenClawMachine = z.infer<typeof ApiDeleteOpenClawMachineSchema>;
export type ApiUpdate = z.infer<typeof ApiUpdateSchema>;

//
// API update container
//

export const ApiUpdateContainerSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: ApiUpdateSchema,
    createdAt: z.number(),
});

export type ApiUpdateContainer = z.infer<typeof ApiUpdateContainerSchema>;

//
// Ephemeral update
//

export const ApiEphemeralActivityUpdateSchema = z.object({
    type: z.literal('activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: z.number(),
    thinking: z.boolean(),
});

const usageMetricMapSchema = z.object({
    total: z.number(),
}).catchall(z.number());

export const ApiEphemeralUsageUpdateSchema = z.object({
    type: z.literal('usage'),
    id: z.string(),
    key: z.string(),
    timestamp: z.number(),
    tokens: usageMetricMapSchema,
    cost: usageMetricMapSchema,
});

export const ApiEphemeralMessageSyncingSchema = z.object({
    type: z.literal('message-syncing'),
    id: z.string(), // session id
    count: z.number(),
});

export const ApiEphemeralMessageSyncedSchema = z.object({
    type: z.literal('message-synced'),
    id: z.string(), // session id
    count: z.number(),
});

export const ApiEphemeralMessageErrorSchema = z.object({
    type: z.literal('message-errored'),
    id: z.string(), // session id
    error: z.string(),
});

export const ApiEphemeralMachineActivityUpdateSchema = z.object({
    type: z.literal('machine-activity'),
    id: z.string(), // machine id
    active: z.boolean(),
    activeAt: z.number(),
});

export const ApiEphemeralUpdateSchema = z.union([
    ApiEphemeralActivityUpdateSchema,
    ApiEphemeralUsageUpdateSchema,
    ApiEphemeralMessageSyncingSchema,
    ApiEphemeralMessageSyncedSchema,
    ApiEphemeralMessageErrorSchema,
    ApiEphemeralMachineActivityUpdateSchema,
]);

export type ApiEphemeralActivityUpdate = z.infer<typeof ApiEphemeralActivityUpdateSchema>;
export type ApiEphemeralMessageSyncingUpdate = z.infer<typeof ApiEphemeralMessageSyncingSchema>;
export type ApiEphemeralMessageSyncedUpdate = z.infer<typeof ApiEphemeralMessageSyncedSchema>;
export type ApiEphemeralMessageErrorUpdate = z.infer<typeof ApiEphemeralMessageErrorSchema>;
export type ApiEphemeralUpdate = z.infer<typeof ApiEphemeralUpdateSchema>;

// Machine metadata updates use Partial<MachineMetadata> from storageTypes
// This matches how session metadata updates work
