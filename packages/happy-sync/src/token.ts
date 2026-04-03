import { z } from 'zod';

export const SyncNodeTokenClaimsSchema = z.object({
    scope: z.discriminatedUnion('type', [
        z.object({
            type: z.literal('account'),
            userId: z.string(),
        }),
        z.object({
            type: z.literal('session'),
            userId: z.string(),
            sessionId: z.string(),
        }),
    ]),
    permissions: z.array(z.enum(['read', 'write', 'admin'])),
});
export type SyncNodeTokenClaims = z.infer<typeof SyncNodeTokenClaimsSchema>;

export interface SyncNodeToken {
    raw: string;
    claims: SyncNodeTokenClaims;
}
