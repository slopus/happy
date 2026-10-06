import { mkdir, mkdtemp, rm, writeFile, access, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ExecutionBindingSchema, ServiceTargetSchema, ServiceErrorCodeSchema, ServicePermissionModeSchema, TurnResultSchema, type CapabilityCatalog, type ExecutionBinding, type ServiceTarget, type TurnActual, type TurnResult, type ServiceErrorCode } from '@slopus/happy-wire';
import type { CodexAccountLaunch } from '@/daemon/codexAccountLaunch';
import { loadApplicationPolicy, type TrustedApplicationLoader, type TrustedBusinessPromptResolver } from './applicationPolicy';
import { readClaudeCapabilities, readCodexCapabilities, sameServiceTarget, validateBoundCapabilities, verifyClaudeIdentity } from './serviceCapabilities';
import { runRestrictedCodex } from './restrictedCodex';
import { runRestrictedClaude } from './restrictedClaude';
import { createRuntimeProcessGuard, type RuntimeProcessGuard } from './runtimeProcessState';

export interface BoundWorkspace { root: string; cwd: string; codexHome: string }
export type BoundCredentialLease =
    | { engine: 'codex'; target: Extract<ServiceTarget, { engine: 'codex' }>; binary: string; launch: Pick<CodexAccountLaunch, 'home' | 'profileId' | 'syncProbeCredential' | 'trackProcess'> }
    | { engine: 'claude'; target: Extract<ServiceTarget, { engine: 'claude' }>; binary: string; env: NodeJS.ProcessEnv };
export interface BoundRuntimeContext {
    machineId: string;
    /** Durable private directory. T4 must run existing credential recovery under the machine lock before use. Retained jobs block new work. */
    workspaceRoot: string;
    /** T4 verifies owner, device, account and discovery authority before issuing a fresh exact-profile grant. */
    acquireDiscovery(target: ServiceTarget, workspace: BoundWorkspace, signal: AbortSignal): Promise<BoundCredentialLease>;
    /** T4 verifies the persisted binding and current grant. Discovery authority cannot substitute for this call. */
    acquireTurn(binding: ExecutionBinding, workspace: BoundWorkspace, signal: AbortSignal): Promise<BoundCredentialLease>;
    loadApplication: TrustedApplicationLoader;
    resolveBusinessPrompt: TrustedBusinessPromptResolver;
}
const identifier = z.string().min(1).max(256);
const inputSchema = z.object({ id: identifier, conversationId: identifier, requestId: identifier, createdAt: z.number().int().nonnegative(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(500000),
        images: z.array(z.string().max(3000000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)).max(4).optional() }).strict()).min(1).max(100),
}).strict().refine(value => value.messages.at(-1)?.role === 'user');
export type BoundTurnInput = z.infer<typeof inputSchema>;
export type BoundTurnEvent = { type: 'text'; text: string } | { type: 'actual'; actual: TurnActual };
export interface BoundServiceRuntime {
    readServiceCapabilities(target: ServiceTarget, signal?: AbortSignal): Promise<CapabilityCatalog>;
    executeBoundTurn(binding: ExecutionBinding, input: BoundTurnInput, signal: AbortSignal, onEvent: (event: BoundTurnEvent) => void): Promise<TurnResult>;
}
function safeCode(error: unknown): ServiceErrorCode {
    const message = error instanceof Error ? error.message : '';
    const parsed = ServiceErrorCodeSchema.safeParse(message);
    if (parsed.success) return parsed.data;
    if (['tool-request-denied', 'tool-surface-not-empty'].includes(message)) return 'permission-denied';
    if (['unsupported-runtime', 'unsupported-claude-runtime'].includes(message)) return 'protocol-incompatible';
    return 'execution-interrupted';
}
/** No implicit credentials, machine-default profile, application policy, or cached execution catalog. */
export function createBoundServiceRuntime(context: BoundRuntimeContext): BoundServiceRuntime {
    if (!isAbsolute(context.workspaceRoot) || !context.machineId || typeof context.acquireDiscovery !== 'function' || typeof context.acquireTurn !== 'function' || typeof context.loadApplication !== 'function' || typeof context.resolveBusinessPrompt !== 'function') throw new Error('permission-denied');
    let busy = false;
    const withLease = async <T>(target: ServiceTarget, acquire: (paths: BoundWorkspace) => Promise<BoundCredentialLease>, signal: AbortSignal,
        use: (lease: BoundCredentialLease, paths: BoundWorkspace, onSpawn: (pid: number) => Promise<void>, processGuard: RuntimeProcessGuard) => Promise<T>): Promise<T> => {
        if (target.machineId !== context.machineId) throw new Error('permission-denied');
        if (busy) throw new Error('resource-busy');
        busy = true;
        let paths: BoundWorkspace | undefined, lease: BoundCredentialLease | undefined;
        try {
            signal.throwIfAborted();
            await mkdir(context.workspaceRoot, { recursive: true, mode: 0o700 });
            const retained = await readdir(context.workspaceRoot, { withFileTypes: true });
            if (retained.some(entry => entry.isDirectory() && entry.name.startsWith('job-'))) throw new Error('resource-busy');
            const root = await mkdtemp(join(context.workspaceRoot, 'job-'));
            paths = { root, cwd: join(root, 'empty'), codexHome: join(root, 'codex') };
            await mkdir(paths.cwd, { mode: 0o700 });
            lease = await acquire(paths);
            if (lease.engine !== target.engine || !sameServiceTarget(target, lease.target)) throw new Error('account-identity-changed');
            if (lease.engine === 'codex' && (target.accountRef.kind !== 'codex-profile' || lease.launch.profileId !== target.accountRef.id || resolve(lease.launch.home) !== resolve(paths.codexHome))) throw new Error('account-identity-changed');
            if (lease.engine === 'claude' && (!lease.env.HOME || !isAbsolute(lease.env.HOME))) throw new Error('account-login-required');
            signal.throwIfAborted();
            return await use(lease, paths, async pid => {
                await writeFile(join(root, '.runtime-started'), '1', { mode: 0o600 });
                await writeFile(join(root, '.runtime-pid'), String(pid), { mode: 0o600 });
                if (lease?.engine === 'codex') lease.launch.trackProcess(pid);
            }, createRuntimeProcessGuard(root));
        } finally {
            try {
                if (paths) {
                    if (lease?.engine === 'codex') {
                        // If this fails, preserve the only refreshed login and launch checkpoint for retry.
                        try { await lease.launch.syncProbeCredential(); } catch { throw new Error('execution-interrupted'); }
                        await rm(paths.root, { recursive: true, force: true });
                    } else if (lease || !await access(join(paths.codexHome, 'auth.json')).then(() => true, () => false)) {
                        await rm(paths.root, { recursive: true, force: true });
                    }
                }
            } finally { busy = false; }
        }
    };
    const discover = (target: ServiceTarget, lease: BoundCredentialLease, paths: BoundWorkspace, signal: AbortSignal, onSpawn: (pid: number) => Promise<void>, processGuard: RuntimeProcessGuard) => lease.engine === 'codex'
        ? readCodexCapabilities(target, lease.binary, lease.launch.home, paths.cwd, signal, onSpawn, processGuard)
        : readClaudeCapabilities(target, lease.binary, lease.env, paths.cwd, signal);
    return {
        async readServiceCapabilities(target, signal = AbortSignal.timeout(20000)) {
            // A binding is structurally a target. Strip only its extra snapshot fields.
            const parsed = ServiceTargetSchema.safeParse({ machineId: target.machineId, engine: target.engine, accountRef: target.accountRef });
            if (!parsed.success) throw new Error('invalid-service-config');
            try { return await withLease(parsed.data, paths => context.acquireDiscovery(parsed.data, paths, signal), signal, (lease, paths, onSpawn, processGuard) => discover(parsed.data, lease, paths, signal, onSpawn, processGuard)); }
            catch (error) { throw new Error(safeCode(error)); }
        },
        async executeBoundTurn(binding, input, signal, onEvent) {
            const parsedBinding = ExecutionBindingSchema.safeParse(binding), parsedInput = inputSchema.safeParse(input);
            // Invalid metadata cannot form a wire result. Transport must reject it as an invalid request.
            if (!parsedBinding.success || !parsedInput.success || Buffer.byteLength(JSON.stringify(input.messages)) > 12000000) throw new Error('invalid-request');
            const bound = parsedBinding.data, turn = parsedInput.data;
            const startedAt = Date.now();
            const actual: TurnActual = { modelId: null, reasoning: null,
                ...(bound.permissionMode === undefined ? {} : { permissionMode: null }),
                ...(bound.serviceTier === undefined ? {} : { serviceTier: null }) };
            let status: TurnResult['status'] = 'completed', error: TurnResult['error'] = null;
            const report = <K extends keyof TurnActual>(field: K, value: NonNullable<TurnActual[K]>) => {
                if (value.trim() && value.length <= 256) { actual[field] = value; onEvent({ type: 'actual', actual: { ...actual } }); }
            };
            try {
                const { systemPrompt } = await loadApplicationPolicy(bound.appId, bound.permissions, context.loadApplication, context.resolveBusinessPrompt, bound.permissionMode);
                await withLease(bound, paths => context.acquireTurn(bound, paths, signal), signal, async (lease, paths, onSpawn, processGuard) => {
                    const catalog = await discover(bound, lease, paths, signal, onSpawn, processGuard);
                    validateBoundCapabilities(bound, catalog, turn.messages.some(message => !!message.images?.length));
                    const options = { systemPrompt, reasoning: bound.reasoning, permissionMode: bound.permissionMode, serviceTier: bound.serviceTier,
                        onReasoning: (value: string) => report('reasoning', value),
                        onPermissionMode: (value: string) => {
                            const parsed = ServicePermissionModeSchema.safeParse(value);
                            if (bound.permissionMode !== undefined && parsed.success) report('permissionMode', parsed.data);
                        },
                        onServiceTier: (value: string) => { if (bound.serviceTier !== undefined) report('serviceTier', value); } };
                    const onText = (text: string) => onEvent({ type: 'text', text });
                    if (lease.engine === 'codex') await runRestrictedCodex(lease.binary, lease.launch.home, paths.cwd, turn.messages, signal, onText, onSpawn, bound.requestedModel, value => report('modelId', value), options, processGuard);
                    else await runRestrictedClaude(lease.binary, paths.cwd, turn.messages, signal, onText, bound.requestedModel, value => report('modelId', value), {
                        ...options, env: lease.env, verifyIdentity: () => verifyClaudeIdentity(bound, lease.binary, lease.env, paths.cwd, signal),
                    });
                    signal.throwIfAborted();
                });
            } catch (failure) {
                status = signal.aborted ? 'cancelled' : 'failed';
                error = { code: signal.aborted ? 'execution-interrupted' : safeCode(failure), retryable: false };
            }
            return TurnResultSchema.parse({ id: turn.id, conversationId: turn.conversationId, requestId: turn.requestId, binding: bound, status, actual,
                createdAt: turn.createdAt, startedAt, completedAt: Date.now(), error });
        },
    };
}
