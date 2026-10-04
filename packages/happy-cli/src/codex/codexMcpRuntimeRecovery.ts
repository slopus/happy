import type { McpRuntimeServerStatus } from '@slopus/happy-wire';
import { readExpectedConnectors } from '@/aplus/fetchAplusMcpServers';

export type CodexMcpStartupStatus = {
    threadId?: string | null;
    name: string;
    status: string;
    error?: string | null;
    failureReason?: string | null;
};

export type CodexMcpServerInventory = {
    runtimeStatus?: string | null;
    name: string;
    authStatus: string;
    tools: Record<string, unknown>;
};

type CodexMcpRuntimeClient = {
    getMcpStartupStatuses: () => CodexMcpStartupStatus[];
    listMcpServerStatus: (opts: { threadId: string; serverNames?: string[] }) => Promise<{
        data: CodexMcpServerInventory[];
        nextCursor?: string | null;
    }>;
    resumeThread: (opts: {
        threadId: string;
        mcpServers: Record<string, unknown>;
        developerInstructions?: string;
    }) => Promise<{ threadId: string; model: string }>;
};

export type CodexMcpRecoveryResult = {
    status: 'ready' | 'recovered' | 'needs-auth' | 'failed';
    affectedServers: string[];
    /** Final successful inspection, for immediate pre-turn reporting only. */
    runtimeStatuses?: McpRuntimeServerStatus[];
    serverStatuses?: Array<{
        name: string;
        status: 'recovered' | 'needs-auth' | 'failed';
    }>;
};

export function buildCodexMcpRecoveryMetadataStatuses(input: {
    recovery: CodexMcpRecoveryResult;
    connectorNames: readonly string[];
    checkedAt: number;
}): McpRuntimeServerStatus[] {
    const connectorNames = new Set(input.connectorNames);
    const serverStatuses = input.recovery.serverStatuses
        ?? input.recovery.affectedServers.map((name) => ({
            name,
            status: input.recovery.status,
        }));

    return serverStatuses.map(({ name, status }) => {
        const runtimeStatus = status === 'recovered'
            ? 'connected' as const
            : status === 'needs-auth'
                ? (connectorNames.has(name) ? 'connector-needs-auth' as const : 'needs-auth' as const)
                : (connectorNames.has(name) ? 'connector-runtime-failed' as const : 'failed' as const);
        return {
            name,
            status: runtimeStatus,
            ...(status === 'needs-auth'
                ? { error: 'MCP authentication is required' }
                : status === 'failed'
                    ? { error: 'MCP runtime initialization failed' }
                    : {}),
            checkedAt: input.checkedAt,
        };
    });
}

type RecoveryOptions = {
    maxAttempts?: number;
    backoffMs?: number;
    cooldownMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    connectorNames?: readonly string[];
};

export type CodexMcpRecoveryStage = 'mcp-inventory' | 'mcp-reconnect' | 'mcp-backoff' | 'mcp-verification';

type RecoveryInput = {
    threadId: string;
    mcpServers: Record<string, unknown>;
    expectedServerNames: string[];
    developerInstructions?: string;
    includeRuntimeStatuses?: boolean;
    measure?: <T>(stage: CodexMcpRecoveryStage, action: () => T | Promise<T>) => T | Promise<T>;
};

type RuntimeInspection = {
    status: 'ready' | 'needs-auth' | 'failed';
    affectedServers: string[];
    needsAuthServers: string[];
    failedServers: string[];
    runtimeStatuses?: McpRuntimeServerStatus[];
};

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CodexMcpRuntimeRecovery {
    private readonly maxAttempts: number;
    private readonly backoffMs: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly connectorNames: Set<string>;
    private readonly inFlight = new Map<string, Promise<CodexMcpRecoveryResult>>();
    private readonly cooldowns = new Map<string, { failureSignature: string; until: number }>();
    private readonly unhealthyServers = new Map<string, string[]>();

    constructor(
        private readonly client: CodexMcpRuntimeClient,
        options: RecoveryOptions = {},
    ) {
        this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
        this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.connectorNames = new Set(options.connectorNames ?? readExpectedConnectors());
    }

    /** Read-only: normal readiness must be visible even when no recovery ran. */
    async readStatuses(input: RecoveryInput): Promise<McpRuntimeServerStatus[]> {
        // An empty reporting scope always yields []; querying all configured
        // app-server MCPs here can wait for unrelated startup on every turn.
        if (input.expectedServerNames.length === 0) return [];
        // Status is informational: every input it reads is untrusted evidence,
        // and no shape of it may throw out of here. A rejection would reach the
        // turn loop, which treats it as a process crash and drops the prompt.
        let startupEntries: CodexMcpStartupStatus[] = [];
        try {
            startupEntries = this.client.getMcpStartupStatuses();
        } catch {
            // Missing startup notifications are unknown, not failure.
        }
        let inventory: Map<string, CodexMcpServerInventory> | undefined;
        try {
            const result = await this.client.listMcpServerStatus({ threadId: input.threadId, serverNames: input.expectedServerNames });
            inventory = new Map(result.data.map((entry) => [entry.name, entry]));
        } catch {
            // No inventory is unknown, never proof of a healthy connection.
        }
        return this.buildStatuses(input, startupEntries, inventory);
    }

    private buildStatuses(
        input: RecoveryInput,
        startupEntries: CodexMcpStartupStatus[],
        inventory: Map<string, CodexMcpServerInventory> | undefined,
    ): McpRuntimeServerStatus[] {
        const startup = new Map(startupEntries
            .filter((entry) => !entry.threadId || entry.threadId === input.threadId)
            .map((entry) => [entry.name, entry]));
        const checkedAt = this.now();
        return [...new Set(input.expectedServerNames)].sort().map((name) => {
            const started = startup.get(name);
            const entry = inventory?.get(name);
            let status: McpRuntimeServerStatus['status'] = 'reconnecting';
            if (entry?.runtimeStatus === 'authenticationRequired' || entry?.authStatus === 'notLoggedIn' || started?.failureReason === 'reauthenticationRequired') {
                status = 'needs-auth';
            } else if (['failed', 'cancelled', 'disabled'].includes(entry?.runtimeStatus ?? '')) {
                status = 'failed';
            } else if (['starting', 'notStarted'].includes(entry?.runtimeStatus ?? '')) {
                status = 'reconnecting';
            } else if (started?.status === 'failed' || started?.status === 'cancelled') {
                status = 'failed';
            } else if (started?.status !== 'starting') {
                // An inventory entry whose auth question is already settled is
                // connected even when it publishes no tools -- a resource- or
                // prompt-only server, or one whose tools are not enumerated yet.
                // `inspect()` reads that same state as ready, so anything
                // stricter here leaves a healthy server stuck on 'reconnecting'
                // with no later path to correct it. Only `unknown` auth still
                // needs tools as corroborating evidence.
                const settledEntry = entry !== undefined && entry.authStatus !== 'unknown';
                if (settledEntry
                    || (entry && Object.keys(entry.tools ?? {}).length > 0)
                    || started?.status === 'ready'
                    || started?.status === 'connected') status = 'connected';
                else if (inventory && !entry) status = 'failed';
            }
            return { name, status: this.qualifyConnector(name, status), checkedAt };
        });
    }

    /**
     * Saycode connectors carry their own wire statuses. Without this the same
     * server flips between `needs-auth` and `connector-needs-auth` depending on
     * which publisher wrote last, and a client cannot tell the two apart.
     * Mirrors `buildCodexMcpRecoveryMetadataStatuses` and Claude's `emit`.
     */
    private qualifyConnector(
        name: string,
        status: McpRuntimeServerStatus['status'],
    ): McpRuntimeServerStatus['status'] {
        if (!this.connectorNames.has(name)) return status;
        if (status === 'failed') return 'connector-runtime-failed';
        if (status === 'needs-auth') return 'connector-needs-auth';
        return status;
    }

    recoverBeforeTurn(input: RecoveryInput): Promise<CodexMcpRecoveryResult> {
        const existing = this.inFlight.get(input.threadId);
        if (existing) return existing;

        const recovery = this.recover(input).finally(() => {
            this.inFlight.delete(input.threadId);
        });
        this.inFlight.set(input.threadId, recovery);
        return recovery;
    }

    private async recover(input: RecoveryInput): Promise<CodexMcpRecoveryResult> {
        const initial = await this.inspect(input);
        const expected = new Set(input.expectedServerNames);
        const initiallyUnhealthy = new Set(initial.affectedServers);
        const previouslyRecovered = (this.unhealthyServers.get(input.threadId) ?? [])
            .filter((name) => expected.has(name) && !initiallyUnhealthy.has(name));
        if (initial.status === 'ready') {
            this.cooldowns.delete(input.threadId);
            this.unhealthyServers.delete(input.threadId);
            if (previouslyRecovered.length > 0) {
                return this.withRuntimeStatuses({ status: 'recovered', affectedServers: previouslyRecovered }, initial);
            }
            return this.withRuntimeStatuses({ status: 'ready', affectedServers: [] }, initial);
        }
        if (initial.failedServers.length === 0) {
            this.cooldowns.delete(input.threadId);
            this.unhealthyServers.set(input.threadId, initial.affectedServers);
            return this.withRuntimeStatuses(this.toResult(initial, previouslyRecovered), initial);
        }
        const failureSignature = JSON.stringify(initial.failedServers);
        const cooldown = this.cooldowns.get(input.threadId);
        if (cooldown?.failureSignature === failureSignature && cooldown.until > this.now()) {
            this.unhealthyServers.set(input.threadId, initial.affectedServers);
            return this.withRuntimeStatuses(this.toResult(initial, previouslyRecovered), initial);
        }

        const initiallyAffected = initial.affectedServers;
        const recoveredSinceInitial = (stillAffected: string[]): string[] => {
            const stillUnhealthy = new Set(stillAffected);
            return [
                ...previouslyRecovered,
                ...initiallyAffected.filter((name) => !stillUnhealthy.has(name)),
            ].sort();
        };
        let latest = initial;
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            let resumed = false;
            try {
                await this.measure(input, 'mcp-reconnect', () => this.client.resumeThread({
                    threadId: input.threadId,
                    mcpServers: input.mcpServers,
                    developerInstructions: input.developerInstructions,
                }));
                resumed = true;
            } catch {
                // Retry below after the same bounded backoff as a status failure.
                // Resume may have changed the runtime before failing. Do not
                // report the earlier inventory as a post-resume observation.
                latest.runtimeStatuses = undefined;
            }
            if (this.backoffMs > 0) {
                await this.measure(input, 'mcp-backoff', () => this.sleep(this.backoffMs * (attempt + 1)));
            }
            if (!resumed) continue;
            latest = await this.inspect(input, 'mcp-verification');
            if (latest.status === 'ready') {
                this.cooldowns.delete(input.threadId);
                this.unhealthyServers.delete(input.threadId);
                return this.withRuntimeStatuses({
                    status: 'recovered',
                    affectedServers: recoveredSinceInitial([]),
                }, latest);
            }
            if (latest.failedServers.length === 0) {
                this.cooldowns.delete(input.threadId);
                this.unhealthyServers.set(input.threadId, latest.affectedServers);
                return this.withRuntimeStatuses(this.toResult(latest, recoveredSinceInitial(latest.affectedServers)), latest);
            }
        }

        this.cooldowns.set(input.threadId, {
            failureSignature: JSON.stringify(latest.failedServers),
            until: this.now() + this.cooldownMs,
        });
        this.unhealthyServers.set(input.threadId, latest.affectedServers);
        return this.withRuntimeStatuses(this.toResult(latest, recoveredSinceInitial(latest.affectedServers)), latest);
    }

    private withRuntimeStatuses(result: CodexMcpRecoveryResult, inspection: RuntimeInspection): CodexMcpRecoveryResult {
        return inspection.runtimeStatuses === undefined
            ? result
            : { ...result, runtimeStatuses: inspection.runtimeStatuses };
    }

    private toResult(
        inspection: RuntimeInspection,
        recoveredServers: string[] = [],
    ): CodexMcpRecoveryResult {
        const serverStatuses = [
            ...recoveredServers.map((name) => ({ name, status: 'recovered' as const })),
            ...inspection.failedServers.map((name) => ({ name, status: 'failed' as const })),
            ...inspection.needsAuthServers.map((name) => ({ name, status: 'needs-auth' as const })),
        ].sort((a, b) => a.name.localeCompare(b.name));
        if (serverStatuses.length === 0) {
            return { status: 'ready', affectedServers: [] };
        }

        const status = inspection.failedServers.length > 0
            ? 'failed' as const
            : inspection.needsAuthServers.length > 0
                ? 'needs-auth' as const
                : 'recovered' as const;
        const result: CodexMcpRecoveryResult = {
            status,
            affectedServers: serverStatuses.map((entry) => entry.name),
        };
        if (new Set(serverStatuses.map((entry) => entry.status)).size > 1) {
            result.serverStatuses = serverStatuses;
        }
        return result;
    }

    private async measure<T>(input: RecoveryInput, stage: CodexMcpRecoveryStage, action: () => T | Promise<T>): Promise<T> {
        if (!input.measure) return action();
        // Diagnostics cannot skip, repeat, replace or swallow the actual operation.
        let operation: Promise<T> | undefined;
        const once = () => operation ??= Promise.resolve().then(action);
        try { await input.measure(stage, once); }
        catch { /* The operation's own result/exception is authoritative below. */ }
        return once();
    }

    private async inspect(input: RecoveryInput, stage: CodexMcpRecoveryStage = 'mcp-inventory'): Promise<RuntimeInspection> {
        const expected = [...new Set(input.expectedServerNames)].sort();
        if (expected.length === 0) {
            return {
                status: 'ready',
                affectedServers: [],
                needsAuthServers: [],
                failedServers: [],
                ...(input.includeRuntimeStatuses ? { runtimeStatuses: [] } : {}),
            };
        }

        const startupByName = new Map(
            this.client.getMcpStartupStatuses()
                .filter((entry) => !entry.threadId || entry.threadId === input.threadId)
                .map((entry) => [entry.name, entry]),
        );
        let inventoryByName: Map<string, CodexMcpServerInventory> | null = null;
        try {
            const inventory = await this.measure(input, stage, () => this.client.listMcpServerStatus({ threadId: input.threadId, serverNames: input.expectedServerNames }));
            inventoryByName = new Map(inventory.data.map((entry) => [entry.name, entry]));
        } catch {
            // Startup notifications remain useful on older app-server versions.
        }

        let runtimeStatuses: McpRuntimeServerStatus[] | undefined;
        if (input.includeRuntimeStatuses && inventoryByName) {
            try {
                // Capture the latest notifications after the inventory RPC;
                // only metadata leaves this operation, not tools or credentials.
                runtimeStatuses = this.buildStatuses(input, this.client.getMcpStartupStatuses(), inventoryByName);
            } catch {
                // Informational reporting must not discard the user's turn.
                // A missing snapshot preserves the caller's fresh probe fallback.
            }
        }

        const needsAuth = expected.filter((name) => {
            const startup = startupByName.get(name);
            const inventory = inventoryByName?.get(name);
            if (inventory?.runtimeStatus === 'authenticationRequired' || inventory?.authStatus === 'notLoggedIn') return true;
            if (inventory && inventory.authStatus !== 'unknown') return false;
            return startup?.failureReason === 'reauthenticationRequired';
        });
        const needsAuthNames = new Set(needsAuth);

        const failed = expected.filter((name) => {
            if (needsAuthNames.has(name)) return false;
            const startup = startupByName.get(name);
            if (['failed', 'cancelled', 'disabled'].includes(inventoryByName?.get(name)?.runtimeStatus ?? '')) return true;
            if (['starting', 'notStarted'].includes(inventoryByName?.get(name)?.runtimeStatus ?? '')) return false;
            if (startup?.status === 'failed' || startup?.status === 'cancelled') return true;
            if (startup?.status === 'starting') return false;
            if (inventoryByName && !inventoryByName.has(name)) return true;
            return false;
        });
        const affectedServers = [...failed, ...needsAuth].sort();
        return {
            status: failed.length > 0 ? 'failed' : needsAuth.length > 0 ? 'needs-auth' : 'ready',
            affectedServers,
            needsAuthServers: needsAuth,
            failedServers: failed,
            runtimeStatuses,
        };
    }
}
