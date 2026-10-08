/** Daemon-owned application execution policy. Session metadata classifies; this local record authorizes. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ExecutionBindingSchema } from '@slopus/happy-wire';
import type { Metadata } from '@/api/types';
import type { CodexEnhancedMode } from '@/codex/codexPrompt';

const policySchema = z.object({ binding: ExecutionBindingSchema, systemPrompt: z.string().min(1), directory: z.string().min(1), sessionId: z.string().optional() }).strict();
export type NativeLaunchPolicy = z.infer<typeof policySchema>;
export const NATIVE_POLICY_ENV = 'HAPPY_NATIVE_APPLICATION_POLICY';
export class NativeLaunchPolicyStore {
    constructor(private readonly root: string) {}
    private path(bindingId: string): string { return join(this.root, createHash('sha256').update(bindingId).digest('hex') + '.json'); }
    async save(policy: NativeLaunchPolicy): Promise<void> {
        const value = policySchema.parse(policy);
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const path = this.path(value.binding.id);
        await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
        await rename(path + '.tmp', path);
        if (value.sessionId) {
            const sessionPath = this.path('session:' + value.sessionId);
            await writeFile(sessionPath + '.tmp', JSON.stringify(value), { mode: 0o600 });
            await rename(sessionPath + '.tmp', sessionPath);
        }
    }
    async forSession(sessionId: string, metadata: Metadata): Promise<NativeLaunchPolicy | undefined> {
        let raw: string;
        try { raw = await readFile(this.path('session:' + sessionId), 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !metadata.application) return undefined;
            throw new Error('Trusted native application policy is unavailable', { cause: error });
        }
        const policy = policySchema.parse(JSON.parse(raw));
        if (policy.sessionId !== sessionId || policy.binding.appId !== metadata.application?.appId || policy.binding.id !== metadata.application?.bindingId || policy.binding.machineId !== metadata.machineId) throw new Error('Native application policy does not match session');
        if (policy.binding.engine === 'codex' && metadata.codexAccountProfileId !== policy.binding.accountRef.id) throw new Error('Native application account does not match session');
        return policy;
    }
}
let loaded = false;
let workerPolicy: NativeLaunchPolicy | undefined;
/** Read once in the wrapper, then remove the trusted transport from provider subprocess environments. */
export function nativeLaunchPolicy(): NativeLaunchPolicy | undefined {
    if (!loaded) {
        const raw = process.env[NATIVE_POLICY_ENV];
        delete process.env[NATIVE_POLICY_ENV];
        workerPolicy = raw ? policySchema.parse(JSON.parse(raw)) : undefined;
        loaded = true;
    }
    return workerPolicy;
}
export function nativeCodexMode(policy: NativeLaunchPolicy): CodexEnhancedMode {
    const binding = policy.binding;
    return { permissionMode: binding.permissionMode === 'yolo' ? 'yolo' : 'read-only', model: binding.requestedModel ?? undefined,
        effort: binding.reasoning.mode === 'explicit' ? binding.reasoning.value as CodexEnhancedMode['effort'] : undefined,
        fast: binding.serviceTier === 'fast' };
}

/** Resolve once per launch and verify the exact executable passed to the SDK. */
export function nativeClaudeExecutable(): string {
    const executable = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (!executable) throw new Error('claude-unavailable');
    return executable;
}
