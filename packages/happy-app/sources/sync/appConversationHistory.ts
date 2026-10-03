import { z } from 'zod';
import { decodeBase64 } from '@/encryption/base64';
import { decryptSecretBox } from '@/encryption/libsodium';

const selectionSchema = z.object({ engine: z.enum(['codex', 'claude']), model: z.string().min(1).max(100) });
const messageSchema = z.object({
    role: z.enum(['user', 'assistant']), text: z.string(),
    images: z.array(z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/)).max(4).optional(),
    selection: selectionSchema.optional(), actualModel: z.string().optional(),
});
const historySchema = z.object({
    app: z.object({ id: z.literal('relationship-advisor'), origin: z.literal('https://advisor.paws.rodeo') }),
    conversationId: z.string(), grantId: z.string(), machineId: z.string(), grantProtocol: z.number().optional(),
    grantExpiresAt: z.string().nullable(), machineEnvelope: z.string(), createdAt: z.string().datetime(),
    turns: z.array(z.object({
        id: z.string(), input: z.string(), output: z.string().nullable(), sequence: z.number().int().nonnegative(),
        state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']), createdAt: z.string().datetime(),
    })).max(1),
});
export type AppConversationHistory = z.infer<typeof historySchema>;
export type AppHistoryMessage = z.infer<typeof messageSchema>;
export interface AppHistoryContent {
    appId: string;
    conversationId: string;
    grantId: string;
    machineId: string;
    createdAt: string;
    messages: AppHistoryMessage[];
    state: 'idle' | AppConversationHistory['turns'][number]['state'];
}

/** Validate account-owned ciphertext before resolving its device key. */
export function parseAppConversationHistory(raw: unknown, conversationId: string): AppConversationHistory {
    const history = historySchema.parse(raw);
    if (history.conversationId !== conversationId) throw new Error('Application conversation context mismatch');
    return history;
}

/** Decrypt in Paws memory only, binding every message to its grant, conversation and turn. */
export function decryptAppConversationHistory(history: AppConversationHistory, envelope: unknown): AppHistoryContent {
    const data = z.object({ v: z.literal(1), grantId: z.string(), appId: z.string(), machineId: z.string(),
        scope: z.string(), protocol: z.number().optional(), expiresAt: z.string().nullable(),
        key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    }).parse(envelope);
    if (data.grantId !== history.grantId || data.appId !== history.app.id || data.machineId !== history.machineId
        || data.expiresAt !== history.grantExpiresAt
        || ((history.grantProtocol ?? 1) >= 3 ? data.scope !== 'agent:chat' || data.protocol !== 3 : data.scope !== 'codex:chat')) {
        throw new Error('Application history binding mismatch');
    }
    const key = decodeBase64(data.key);
    if (key.length !== 32) throw new Error('Invalid application key');
    const turn = history.turns[0];
    const messages: AppHistoryMessage[] = [];
    if (turn) {
        const decode = (ciphertext: string, direction: 'input' | 'output', sequence: number) => {
            const value = z.object({ v: z.union([z.literal(1), z.literal(2)]), grantId: z.string(), conversationId: z.string(),
                turnId: z.string(), direction: z.string(), sequence: z.number(), selection: selectionSchema.optional(),
            }).passthrough().parse(decryptSecretBox(decodeBase64(ciphertext), key));
            if (value.grantId !== history.grantId || value.conversationId !== history.conversationId || value.turnId !== turn.id
                || value.direction !== direction || value.sequence !== sequence) throw new Error('Application message context mismatch');
            return value;
        };
        const input = decode(turn.input, 'input', 0);
        if (input.v === 2 && !input.selection) throw new Error('Missing model selection');
        messages.push(...z.array(messageSchema).max(100).parse(input.messages));
        if (turn.output) {
            const output = decode(turn.output, 'output', turn.sequence);
            if (input.v !== output.v || input.selection?.engine !== output.selection?.engine || input.selection?.model !== output.selection?.model) {
                throw new Error('Application model context mismatch');
            }
            const text = z.string().parse(output.text ?? '');
            if (text) messages.push(messageSchema.parse({ role: 'assistant', text, selection: input.selection, actualModel: output.actualModel }));
        }
    }
    return { appId: history.app.id, conversationId: history.conversationId, grantId: history.grantId,
        machineId: history.machineId, createdAt: history.createdAt, messages, state: turn?.state ?? 'idle' };
}
