import { z } from 'zod';

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
});

export const ApiUpdateMachineStateSchema = z.object({
    t: z.literal('update-machine'),
    id: z.string(),
    metadata: z.object({
        version: z.number(),
        value: z.string() // Encrypted, client decrypts
    }).nullish(),
});

export const ApiUpdateSchema = z.discriminatedUnion('t', [
    ApiUpdateNewMessageSchema,
    ApiUpdateNewSessionSchema,
    ApiUpdateSessionStateSchema,
    ApiUpdateAccountSchema,
    ApiUpdateMachineStateSchema
]);

export type ApiUpdateNewMessage = z.infer<typeof ApiUpdateNewMessageSchema>;
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

export const ApiEphemeralUsageUpdateSchema = z.object({
    type: z.literal('usage'),
    id: z.string(),
    key: z.string(),
    timestamp: z.number(),
    tokens: z.object({
        total: z.number(),
        input: z.number(),
        output: z.number(),
        cache_creation: z.number(),
        cache_read: z.number(),
    }),
    cost: z.object({
        total: z.number(),
        input: z.number(),
        output: z.number(),
    }),
});

export const ApiEphemeralDaemonStatusUpdateSchema = z.object({
    type: z.literal('daemon-status'),
    machineId: z.string(),
    status: z.enum(['online', 'offline']),
});

export const ApiEphemeralUpdateSchema = z.union([
    ApiEphemeralActivityUpdateSchema,
    ApiEphemeralUsageUpdateSchema,
    ApiEphemeralDaemonStatusUpdateSchema,
]);

export type ApiEphemeralUpdate = z.infer<typeof ApiEphemeralUpdateSchema>;