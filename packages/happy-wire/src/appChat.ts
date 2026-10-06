import { z } from 'zod';
import { AIServiceProtocolSchema } from './aiServices';

/** The application chat surface accepts model IDs, never arbitrary CLI options. */
export const appChatModels = {
    codex: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
    claude: ['sonnet', 'opus', 'haiku'],
} as const;
export type AppChatEngine = keyof typeof appChatModels;
export interface AppChatSelection { engine: AppChatEngine; model: string }
export const defaultAppChatSelection: AppChatSelection = { engine: 'codex', model: 'gpt-6-astra' };
export function parseAppChatSelection(value: unknown): AppChatSelection {
    if (value === undefined) return { ...defaultAppChatSelection };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-model-selection');
    const selection = value as Record<string, unknown>;
    if (Object.keys(selection).some(key => !['engine', 'model'].includes(key)) ||
        !['codex', 'claude'].includes(String(selection.engine)) || typeof selection.model !== 'string' ||
        !(appChatModels[selection.engine as AppChatEngine] as readonly string[]).includes(selection.model)) throw new Error('invalid-model-selection');
    return { engine: selection.engine as AppChatEngine, model: selection.model };
}

export const LegacyAppChatProtocolSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type LegacyAppChatProtocol = z.infer<typeof LegacyAppChatProtocolSchema>;
export const AppChatProtocolSchema = z.union([LegacyAppChatProtocolSchema, AIServiceProtocolSchema]);
export type AppChatProtocol = z.infer<typeof AppChatProtocolSchema>;

export const AppChatProtocolBindingSchema = z.union([
    z.object({ protocol: z.literal(1), scope: z.literal('codex:chat') }).strict(),
    z.object({ protocol: z.literal(2), scope: z.literal('codex:chat') }).strict(),
    z.object({ protocol: z.literal(3), scope: z.literal('agent:chat') }).strict(),
    z.object({ protocol: AIServiceProtocolSchema, scope: z.literal('service:chat') }).strict(),
]);
export type AppChatProtocolBinding = z.infer<typeof AppChatProtocolBindingSchema>;

/** Missing version retains legacy protocol 1. Never select a newer protocol implicitly. */
export function negotiateAppChatProtocol(requested: unknown, supported: readonly AppChatProtocol[]): AppChatProtocol {
    const parsed = AppChatProtocolSchema.safeParse(requested === undefined ? 1 : requested);
    if (!parsed.success || !supported.includes(parsed.data)) throw new Error('protocol-incompatible');
    return parsed.data;
}

export function parseAppChatProtocol(value: unknown): AppChatProtocolBinding {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('protocol-incompatible');
    const input = value as Record<string, unknown>;
    const parsed = AppChatProtocolBindingSchema.safeParse({ ...input, protocol: input.protocol === undefined ? 1 : input.protocol });
    if (!parsed.success) throw new Error('protocol-incompatible');
    return parsed.data;
}
