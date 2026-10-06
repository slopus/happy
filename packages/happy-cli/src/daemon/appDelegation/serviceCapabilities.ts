import { codexServiceError } from './nativeServiceErrors';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AI_SERVICES_PROTOCOL, CapabilityCatalogSchema, type CapabilityCatalog, type ExecutionBinding, type ServiceTarget } from '@slopus/happy-wire';
import type { RuntimeProcessGuard } from './runtimeProcessState';
import { codexRestrictedArgs, restrictedCodexEnv, verifyRestrictedCodex } from './restrictedCodex';
import { verifyRestrictedClaude, restrictedClaudeEnv } from './restrictedClaude';

export function sameServiceTarget(a: ServiceTarget, b: ServiceTarget): boolean {
    return a.machineId === b.machineId && a.engine === b.engine && a.accountRef.kind === b.accountRef.kind &&
        (a.accountRef.kind === 'codex-profile' && b.accountRef.kind === 'codex-profile' ? a.accountRef.id === b.accountRef.id :
            a.accountRef.kind === 'device-identity' && b.accountRef.kind === 'device-identity' && a.accountRef.identityId === b.accountRef.identityId && a.accountRef.machineId === b.accountRef.machineId);
}
/** Stable native identity evidence only. No token, expiry, status, or local path enters the ID. */
export function claudeIdentityId(value: unknown): string {
    const login = z.object({ loggedIn: z.literal(true), authMethod: z.string(), apiProvider: z.string(), email: z.string().min(1).optional(), orgId: z.string().min(1), accountUuid: z.string().min(1).optional() }).safeParse(value);
    if (!login.success || (!login.data.email && !login.data.accountUuid) || !['claude.ai', 'oauth'].includes(login.data.authMethod)) throw new Error('account-login-required');
    const { apiProvider, email, orgId, accountUuid } = login.data;
    return 'claude:' + createHash('sha256').update(JSON.stringify([apiProvider, accountUuid ?? email!.trim().toLowerCase(), orgId])).digest('hex');
}
export async function verifyClaudeIdentity(target: ServiceTarget, binary: string, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<void> {
    if (target.engine !== 'claude') throw new Error('account-identity-changed');
    // Alternate API credentials do not prove ownership of the subscription login reported by auth status.
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) throw new Error('account-login-required');
    const { stdout } = await promisify(execFile)(binary, ['auth', 'status', '--json'], { cwd, env: restrictedClaudeEnv(env), signal, timeout: 5000, maxBuffer: 65536 });
    let status: unknown;
    try { status = JSON.parse(stdout); } catch { throw new Error('account-login-required'); }
    if (claudeIdentityId(status) !== target.accountRef.identityId) throw new Error('account-identity-changed');
}
export async function readClaudeCapabilities(target: ServiceTarget, binary: string, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<CapabilityCatalog> {
    if (!await verifyRestrictedClaude(binary)) throw new Error('protocol-incompatible');
    await verifyClaudeIdentity(target, binary, env, cwd, signal);
    const { stdout } = await promisify(execFile)(binary, ['--help'], { cwd, env: restrictedClaudeEnv(env), signal, timeout: 5000, maxBuffer: 128 * 1024 });
    const modelStart = stdout.indexOf('--model <model>');
    const section = modelStart < 0 ? '' : stdout.slice(modelStart).split(/\n\s{2,}--[\w-]|\n\s{2,}-\w/)[0];
    // Help exposes finite native aliases, not account entitlement or per-model effort support.
    const aliases = [...new Set([...section.matchAll(/'(opus|sonnet|haiku|fable)'/g)].map(match => match[1]))];
    return CapabilityCatalogSchema.parse({ machineId: target.machineId, engine: target.engine, accountRef: target.accountRef, protocol: AI_SERVICES_PROTOCOL, observedAt: Date.now(), availability: 'online', completeness: 'limited', defaultModelId: null,
        models: aliases.map(id => ({ id, name: id, supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } })) });
}
const nativeModelSchema = z.object({ model: z.string().min(1), displayName: z.string().min(1), isDefault: z.boolean(), hidden: z.boolean().optional(),
    inputModalities: z.array(z.string()).optional(), input_modalities: z.array(z.string()).optional(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })), defaultReasoningEffort: z.string().nullable() });
const modelPageSchema = z.object({ data: z.array(nativeModelSchema), nextCursor: z.string().nullable().optional() });
/** Read-only app-server session. No thread or turn is created. */
export async function readCodexCapabilities(target: ServiceTarget, binary: string, home: string, cwd: string, signal: AbortSignal, onSpawn?: (pid: number) => Promise<void>, processGuard?: RuntimeProcessGuard): Promise<CapabilityCatalog> {
    if (target.engine !== 'codex') throw new Error('account-identity-changed');
    if (!await verifyRestrictedCodex(binary)) throw new Error('protocol-incompatible');
    signal.throwIfAborted();
    const generation = await processGuard?.beforeSpawn();
    signal.throwIfAborted();
    const child = spawn(binary, codexRestrictedArgs(null), { cwd, env: restrictedCodexEnv(home, cwd), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    let serial = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const fail = () => { for (const call of pending.values()) call.reject(new Error('machine-offline')); pending.clear(); child.kill(); };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    lines.on('line', line => {
        if (line.length > 2 * 1024 * 1024) { fail(); return; }
        let event: any; try { event = JSON.parse(line); } catch { return; }
        if (event.id != null && event.method) { child.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: 'Tools unavailable' } }) + '\n'); fail(); return; }
        const call = pending.get(event.id); if (!call) return;
        pending.delete(event.id); event.error ? call.reject(new Error(codexServiceError(event.error))) : call.resolve(event.result);
    });
    const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
        pending.set(++serial, { resolve, reject }); child.stdin.write(JSON.stringify({ id: serial, method, params }) + '\n');
    });
    const abort = () => fail(); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(fail, 15000);
    try {
        if (!child.pid) throw new Error('machine-offline');
        if (processGuard && generation) await processGuard.spawned(generation, child.pid);
        await onSpawn?.(child.pid);
        signal.throwIfAborted();
        await request('initialize', { clientInfo: { name: 'paws_service_discovery', version: '1' }, capabilities: { experimentalApi: true } });
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        const models: CapabilityCatalog['models'] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null, defaultModelId: string | null = null;
        do {
            const page = modelPageSchema.parse(await request('model/list', { cursor, includeHidden: false, limit: 100 }));
            for (const model of page.data) {
                if (model.hidden) continue;
                const values = [...new Set(model.supportedReasoningEfforts.map(option => option.reasoningEffort))];
                models.push({ id: model.model, name: model.displayName, supportsImages: (model.inputModalities ?? model.input_modalities ?? []).includes('image'),
                    reasoning: { supportsDefault: true, values, defaultValue: model.defaultReasoningEffort } });
                if (model.isDefault) defaultModelId = model.model;
            }
            cursor = page.nextCursor ?? null;
            if (models.length > 1024 || (cursor && cursors.has(cursor))) throw new Error('protocol-incompatible');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        signal.throwIfAborted();
        return CapabilityCatalogSchema.parse({ machineId: target.machineId, engine: target.engine, accountRef: target.accountRef, protocol: AI_SERVICES_PROTOCOL, observedAt: Date.now(), availability: 'online', completeness: 'complete', models, defaultModelId });
    } finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort); child.kill(); lines.close();
        await new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
            const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
            child.once('close', () => { clearTimeout(timer); resolve(); });
        });
    }
}
export function validateBoundCapabilities(binding: ExecutionBinding, value: unknown, hasImages: boolean): CapabilityCatalog {
    const parsed = CapabilityCatalogSchema.safeParse(value);
    if (!parsed.success) throw new Error('protocol-incompatible');
    const catalog = parsed.data;
    if (!sameServiceTarget(binding, catalog)) throw new Error('account-identity-changed');
    if (catalog.availability !== 'online' || catalog.observedAt > Date.now() || Date.now() - catalog.observedAt > 60000) throw new Error('machine-offline');
    if (!binding.permissions.includes('chat') || (hasImages && !binding.permissions.includes('images'))) throw new Error('permission-denied');
    const model = catalog.models.find(model => model.id === (binding.requestedModel ?? catalog.defaultModelId));
    if (!model) throw new Error('model-unavailable');
    if ((hasImages || binding.permissions.includes('images')) && !model.supportsImages) throw new Error('parameter-unsupported');
    if (binding.reasoning.mode === 'default' ? !model.reasoning.supportsDefault : !model.reasoning.values.includes(binding.reasoning.value)) throw new Error('parameter-unsupported');
    return catalog;
}
