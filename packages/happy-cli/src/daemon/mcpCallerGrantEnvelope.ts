import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';

const EPHEMERAL_PUBLIC_KEY_BYTES = tweetnacl.box.publicKeyLength;
const NONCE_BYTES = tweetnacl.box.nonceLength;
const MAX_GRANT_BYTES = 8 * 1024;
const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_MAX_REPLAY_ENTRIES = 4_096;
const CALLER_GRANT_ENV_KEY = 'HAPPY_APLUS_MCP_CALLER_GRANT';

type ConsumeFailureReason =
    | 'invalid-envelope'
    | 'invalid-grant'
    | 'wrong-machine'
    | 'wrong-project'
    | 'expired'
    | 'replayed'
    | 'capacity';

export type McpCallerGrantEnvelopeResult =
    | { ok: true; grant: string }
    | { ok: false; reason: ConsumeFailureReason };

type ParsedGrant = {
    machineId: string;
    projectId: string | null;
    iat: number;
    exp: number;
};

/**
 * The RPC caller controls environmentVariables, so it must never be able to
 * bypass the encrypted envelope by placing a plaintext grant there.
 */
export function injectMcpCallerGrant(
    environmentVariables: Record<string, string>,
    decryptedGrant: string | undefined,
    trustedConfigUrl?: string,
    projectId: string | null = null,
    expectedConnectors: string[] = [],
    lifecycle?: 'spawn' | 'resume',
): Record<string, string> {
    const sanitized = Object.fromEntries(
        Object.entries(environmentVariables)
            .filter(([key]) => (
                !key.startsWith('HAPPY_APLUS_')
                && !key.startsWith('HAPPY_BROWSER_VIEWER_')
                // Managed runtime identity and state paths must not reach agent
                // code: the default spawn path forwards the daemon's whole
                // environment, so anything left here is readable by the agent.
                && !key.startsWith('HAPPY_MANAGED_')
                /*
                 * Lesson host settings the daemon owns.
                 *
                 * `HAPPY_LESSON_DAEMON_HOME` decides which state root the
                 * session's settings and spending ledger come from, so a
                 * caller that could set it would point a session at a
                 * settings file with recall on and a ledger with no history —
                 * past both the user's "off" and the machine-wide budget.
                 */
                && !key.startsWith('HAPPY_LESSON_')
                /*
                 * The memory layer's own configuration, including
                 * `CLAUDE_MEMORY_LESSON_OWNER` — the marker that tells CML's
                 * native hook to stand down because this host is injecting.
                 * A caller setting it would silence the native path while no
                 * host was running, which is how a session ends up with no
                 * lessons at all; and
                 * `CLAUDE_MEMORY_LESSON_HOST_ROOT` names the package a lesson
                 * store is loaded from.
                 */
                && !key.startsWith('CLAUDE_MEMORY_')
            )),
    );
    if (trustedConfigUrl) {
        try {
            const configUrl = new URL(trustedConfigUrl);
            configUrl.searchParams.delete('projectId');
            if (projectId) configUrl.searchParams.set('project_id', projectId);
            else configUrl.searchParams.delete('project_id');
            sanitized.HAPPY_APLUS_MCP_CONFIG_URL = configUrl.toString();
        } catch {
            // A malformed daemon-owned URL will fail closed in the child.
        }
    }
    if (decryptedGrant) sanitized[CALLER_GRANT_ENV_KEY] = decryptedGrant;
    if (expectedConnectors.length > 0) {
        sanitized.HAPPY_APLUS_EXPECTED_CONNECTORS = JSON.stringify(expectedConnectors);
    }
    if (lifecycle) sanitized.HAPPY_APLUS_MCP_INITIAL_LIFECYCLE = lifecycle;
    return sanitized;
}

function decodeEnvelope(value: string): Uint8Array | null {
    if (!value || value.length > 16 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return null;
    }
    try {
        const decoded = new Uint8Array(Buffer.from(value, 'base64'));
        return decoded.length > EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES + tweetnacl.box.overheadLength
            ? decoded
            : null;
    } catch {
        return null;
    }
}

function parseGrant(value: string): ParsedGrant | null {
    if (!value || Buffer.byteLength(value, 'utf8') > MAX_GRANT_BYTES) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
        if (payload.version !== 1) return null;
        if (typeof payload.userId !== 'string' || !payload.userId) return null;
        if (typeof payload.machineId !== 'string' || !payload.machineId) return null;
        if (payload.projectId !== null && (typeof payload.projectId !== 'string' || !payload.projectId)) return null;
        if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
        if (typeof payload.nonce !== 'string' || !payload.nonce) return null;
        return {
            machineId: payload.machineId,
            projectId: payload.projectId,
            iat: payload.iat,
            exp: payload.exp,
        };
    } catch {
        return null;
    }
}

/**
 * Decrypts browser-minted caller grants and prevents an observed shared RPC
 * payload from being replayed into a second child process. The server remains
 * the authority for the HMAC; this layer validates only the safe envelope and
 * bounded public claims needed before placing the opaque grant in child env.
 */
export class McpCallerGrantEnvelopeConsumer {
    private readonly consumed = new Map<string, number>();
    private readonly now: () => number;
    private readonly maxEntries: number;

    constructor(private readonly options: {
        machineId: string;
        secretKey: Uint8Array;
        now?: () => number;
        maxEntries?: number;
    }) {
        if (options.secretKey.length !== tweetnacl.box.secretKeyLength) {
            throw new Error('MCP caller grant secret key must be 32 bytes');
        }
        this.now = options.now ?? Date.now;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_REPLAY_ENTRIES;
    }

    consume(
        envelope: string,
        context: { projectId: string | null },
    ): McpCallerGrantEnvelopeResult {
        const bundle = decodeEnvelope(envelope);
        if (!bundle) return { ok: false, reason: 'invalid-envelope' };

        const ephemeralPublicKey = bundle.slice(0, EPHEMERAL_PUBLIC_KEY_BYTES);
        const nonce = bundle.slice(EPHEMERAL_PUBLIC_KEY_BYTES, EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES);
        const ciphertext = bundle.slice(EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES);
        const plaintext = tweetnacl.box.open(
            ciphertext,
            nonce,
            ephemeralPublicKey,
            this.options.secretKey,
        );
        if (!plaintext) return { ok: false, reason: 'invalid-envelope' };

        let grant: string;
        try {
            grant = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
        } catch {
            return { ok: false, reason: 'invalid-grant' };
        }
        const parsed = parseGrant(grant);
        if (!parsed) return { ok: false, reason: 'invalid-grant' };
        if (parsed.machineId !== this.options.machineId) return { ok: false, reason: 'wrong-machine' };
        if (parsed.projectId !== context.projectId) {
            return { ok: false, reason: 'wrong-project' };
        }

        const now = this.now();
        if (parsed.exp < now) return { ok: false, reason: 'expired' };
        if (
            parsed.iat - now > MAX_CLOCK_SKEW_MS
            || parsed.exp < parsed.iat
            || parsed.exp - parsed.iat > MAX_GRANT_TTL_MS
        ) {
            return { ok: false, reason: 'invalid-grant' };
        }

        for (const [hash, expiresAt] of this.consumed) {
            if (expiresAt < now) this.consumed.delete(hash);
        }
        const hash = createHash('sha256').update(grant).digest('base64url');
        if (this.consumed.has(hash)) return { ok: false, reason: 'replayed' };
        if (this.consumed.size >= this.maxEntries) return { ok: false, reason: 'capacity' };

        this.consumed.set(hash, parsed.exp);
        return { ok: true, grant };
    }
}

export function prepareMcpChildEnvironment(
    input: {
        environmentVariables: Record<string, string>;
        mcpCallerGrantEnvelope?: string;
        mcpConfigProjectId?: string;
        expectedConnectors?: string[];
        lifecycle?: 'spawn' | 'resume';
        trustedConfigUrl?: string;
    },
    consumer: Pick<McpCallerGrantEnvelopeConsumer, 'consume'>,
): { ok: true; environmentVariables: Record<string, string> }
    | { ok: false; reason: ConsumeFailureReason } {
    const projectId = input.mcpConfigProjectId?.trim() || null;
    let grant: string | undefined;
    if (input.mcpCallerGrantEnvelope) {
        const consumed = consumer.consume(input.mcpCallerGrantEnvelope, { projectId });
        if (!consumed.ok) return consumed;
        grant = consumed.grant;
    }
    return {
        ok: true,
        environmentVariables: injectMcpCallerGrant(
            input.environmentVariables,
            grant,
            input.trustedConfigUrl,
            projectId,
            input.expectedConnectors,
            input.lifecycle,
        ),
    };
}
