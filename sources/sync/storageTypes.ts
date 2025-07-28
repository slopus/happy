import { z } from "zod";
import { NormalizedMessage } from "./typesRaw";

//
// Agent states
//

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    os: z.string().optional(),
    encryption: z.object({
        type: z.literal('aes-gcm-256'),
        key: z.string(),
    }).nullish(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).nullish()
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
    })).nullish(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    agentState: AgentState | null,
    lastMessage: NormalizedMessage | null,
    thinking: boolean,
    thinkingAt: number,
    presence: "online" | number, // "online" when active, timestamp when last seen
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}