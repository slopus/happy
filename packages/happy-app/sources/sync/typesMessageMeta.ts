import { z } from 'zod';

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(), // Source identifier
    // Capability at send time, inside the encrypted payload. New history can
    // resume waiting after reconnect without holding pre-receipt-era messages.
    expectsAcceptance: z.boolean().optional(),
    // Snapshot at send time, not the agent's live state: starting this message's
    // own turn must not briefly make an idle send look queued.
    queuedWhileBusy: z.boolean().optional(),
    permissionMode: z.string().optional(), // Permission mode key for this message
    model: z.string().nullable().optional(), // Model name for this message (null = reset)
    modelProviderId: z.string().optional(), // Provider qualifier for metadata-driven clients such as Rig
    fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
    effort: z.string().nullable().optional(), // Reasoning / thinking effort for this message (null = reset)
    displayText: z.string().optional() // Optional text to display in UI instead of actual message text
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
