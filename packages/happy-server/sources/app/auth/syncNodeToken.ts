import type { SyncNodeTokenClaims } from "@slopus/happy-sync";
// `tsx` in the server runtime does not expose workspace package named exports
// reliably via `@slopus/happy-sync`, but it does resolve the built ESM entry.
import { SyncNodeTokenClaimsSchema } from "../../../../happy-sync/dist/index.mjs";

export const ServerSyncNodeTokenClaimsSchema = SyncNodeTokenClaimsSchema;

export function buildAccountSyncNodeClaims(userId: string): SyncNodeTokenClaims {
    return {
        scope: {
            type: "account",
            userId,
        },
        permissions: ["read", "write", "admin"],
    };
}

export function buildSessionSyncNodeClaims(userId: string, sessionId: string): SyncNodeTokenClaims {
    return {
        scope: {
            type: "session",
            userId,
            sessionId,
        },
        permissions: ["read", "write"],
    };
}

export function resolveSyncNodeTokenClaims(userId: string, extras: unknown): SyncNodeTokenClaims | null {
    if (!extras || typeof extras !== "object" || Array.isArray(extras)) {
        return buildAccountSyncNodeClaims(userId);
    }

    const extrasRecord = extras as Record<string, unknown>;
    if (!("syncNode" in extrasRecord)) {
        return buildAccountSyncNodeClaims(userId);
    }

    const parsed = ServerSyncNodeTokenClaimsSchema.safeParse(extrasRecord.syncNode);
    if (!parsed.success) {
        return null;
    }

    const claims = parsed.data;
    if (claims.scope.userId !== userId) {
        return null;
    }

    return claims;
}

export function isAccountScopedSyncNodeToken(claims: SyncNodeTokenClaims): boolean {
    return claims.scope.type === "account";
}

export function canAccessSession(claims: SyncNodeTokenClaims, sessionId: string): boolean {
    return claims.scope.type === "account" || claims.scope.sessionId === sessionId;
}
