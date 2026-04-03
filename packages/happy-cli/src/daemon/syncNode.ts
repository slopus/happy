/**
 * Daemon SyncNode — account-scoped SyncNode for session lifecycle.
 *
 * The daemon uses this to:
 * - Create sessions (on behalf of the mobile app or CLI)
 * - List sessions
 * - Stop sessions
 * - Listen for new session events
 *
 * The daemon does NOT hold message state — each CLI session process has its
 * own session-scoped SyncNode. The daemon is lifecycle only.
 */

import {
    SyncNode,
    type SyncNodeToken,
    SyncNodeTokenClaimsSchema,
    type KeyMaterial,
    type SessionID,
    type SessionInfo,
} from '@slopus/happy-sync';
import { z } from 'zod';

const MintSessionTokenResponseSchema = z.object({
    token: z.string(),
    claims: SyncNodeTokenClaimsSchema,
});

export interface DaemonSyncNodeOpts {
    serverUrl: string;
    token: SyncNodeToken;
    keyMaterial: KeyMaterial;
}

export class DaemonSyncNode {
    readonly node: SyncNode;
    private readonly serverUrl: string;
    private readonly rawToken: string;

    constructor(opts: DaemonSyncNodeOpts) {
        this.serverUrl = opts.serverUrl;
        this.rawToken = opts.token.raw;
        this.node = new SyncNode(opts.serverUrl, opts.token, opts.keyMaterial);
    }

    async connect(): Promise<void> {
        await this.node.connect();
    }

    disconnect(): void {
        this.node.disconnect();
    }

    /** Create a new session. Returns the session ID. */
    async createSession(opts: {
        directory: string;
        projectID: string;
        title?: string;
        parentID?: SessionID;
    }): Promise<SessionID> {
        return this.node.createSession(opts) as any;
    }

    /** List all known sessions. */
    listSessions(): SessionInfo[] {
        return this.node.listSessions() as any;
    }

    /** Stop a session. */
    async stopSession(sessionId: SessionID): Promise<void> {
        return this.node.stopSession(sessionId);
    }

    /** Mint a session-scoped token for a CLI session process.
     *  The daemon passes this to the spawned process via env var. */
    async buildSessionToken(sessionId: SessionID): Promise<SyncNodeToken> {
        const accountScope = this.node['token'].claims.scope;
        if (accountScope.type !== 'account') {
            throw new Error('DaemonSyncNode must use account-scoped token');
        }

        const response = await fetch(`${this.serverUrl}/v1/sessions/${sessionId}/token`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.rawToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            throw new Error(`Failed to mint session token: ${response.status} ${response.statusText}`);
        }

        const parsed = MintSessionTokenResponseSchema.parse(await response.json());
        return {
            raw: parsed.token,
            claims: parsed.claims,
        };
    }

    /** Listen for new sessions appearing. */
    onNewSession(callback: (sessionId: SessionID) => void): () => void {
        const seen = new Set<string>();
        for (const [id] of this.node.state.sessions) {
            seen.add(id);
        }

        return this.node.onStateChange(() => {
            for (const [id] of this.node.state.sessions) {
                if (!seen.has(id)) {
                    seen.add(id);
                    callback(id as SessionID);
                }
            }
        });
    }
}
