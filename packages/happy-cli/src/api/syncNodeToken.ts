import {
    type SyncNodeToken,
    SyncNodeTokenClaimsSchema,
} from '@slopus/happy-sync';

export async function resolveSessionScopedSyncNodeToken(opts: {
    serverUrl: string;
    sessionId: string;
    token: SyncNodeToken;
}): Promise<SyncNodeToken> {
    if (opts.token.claims.scope.type === 'session') {
        if (opts.token.claims.scope.sessionId !== opts.sessionId) {
            throw new Error(
                `Session-scoped sync token targets ${opts.token.claims.scope.sessionId}, expected ${opts.sessionId}`,
            );
        }
        return opts.token;
    }

    const response = await fetch(
        `${opts.serverUrl}/v1/sessions/${encodeURIComponent(opts.sessionId)}/token`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${opts.token.raw}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        },
    );

    if (!response.ok) {
        throw new Error(
            `Failed to mint session-scoped sync token: ${response.status} ${response.statusText}`,
        );
    }

    const body = await response.json() as {
        token?: unknown;
        claims?: unknown;
    };

    if (typeof body.token !== 'string') {
        throw new Error('Server did not return a sync token');
    }

    const claims = SyncNodeTokenClaimsSchema.parse(body.claims);
    if (claims.scope.type !== 'session' || claims.scope.sessionId !== opts.sessionId) {
        throw new Error(`Minted sync token is not scoped to session ${opts.sessionId}`);
    }

    return {
        raw: body.token,
        claims,
    };
}
