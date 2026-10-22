import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export const independentTaskSchema = z.object({
    requestId: z.string().min(1).max(128),
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(100000),
    directory: z.string().min(1).refine(isAbsolute, 'Working directory must be absolute').optional(),
});
export const delegationContextSchema = z.object({ appendSystemPrompt: z.string().max(100000).optional(), permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional() });
export type DelegationContext = z.infer<typeof delegationContextSchema>;
export type IndependentTask = z.infer<typeof independentTaskSchema>;
export type IndependentTaskResult = { success: boolean; sessionId?: string; title: string; error?: string };

export function independentTaskMessage(prompt: string, permissionMode?: string, appendSystemPrompt?: string) {
    return {
        role: 'user', content: { type: 'text', text: prompt },
        meta: { sentFrom: 'paws-delegation', permissionMode: permissionMode ?? 'read-only', permissionModeExplicit: true,
            ...(appendSystemPrompt ? { appendSystemPrompt } : {}) },
    };
}

/** One promise per parent/request prevents a transport retry from launching duplicate work. */
export function createIndependentSessionLauncher(deps: {
    findSession: (id: string) => TrackedSession | undefined;
    readMetadata: (session: TrackedSession) => Promise<Metadata | null>;
    grant: (sourceSessionId: string) => Promise<string>;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    send: (session: TrackedSession, prompt: string, localId: string, permissionMode?: string, appendSystemPrompt?: string) => Promise<void>;
}) {
    const requests = new Map<string, { input: string; sessionId?: string; promise?: Promise<IndependentTaskResult>; result?: IndependentTaskResult }>();
    return (parentSessionId: string, task: IndependentTask, context?: DelegationContext): Promise<IndependentTaskResult> => {
        const key = JSON.stringify([parentSessionId, task.requestId]);
        const input = JSON.stringify({ task, context });
        const existing = requests.get(key);
        if (existing && existing.input !== input) return Promise.resolve({ success: false, title: task.title, error: 'requestId was already used for a different task' });
        if (existing?.promise) return existing.promise;
        if (existing?.result?.success) return Promise.resolve(existing.result);
        if (!existing && requests.size >= 1000) return Promise.resolve({ success: false, title: task.title, error: 'Independent task limit reached for this daemon' });
        const record: { input: string; sessionId?: string; promise?: Promise<IndependentTaskResult>; result?: IndependentTaskResult } = existing ?? { input };
        requests.set(key, record);
        const promise = (async (): Promise<IndependentTaskResult> => {
            let sessionId: string | undefined = record.sessionId;
            try {
                const parent = deps.findSession(parentSessionId);
                const metadata = parent ? await deps.readMetadata(parent) : null;
                if (!metadata || !parent?.encryption) throw new Error('Parent session is not tracked by this daemon');
                if (metadata.application || metadata.sandbox?.enabled) throw new Error('Independent sessions are unavailable for application-bound or sandboxed sessions');
                if (metadata.flavor !== 'codex' && metadata.flavor !== 'claude') throw new Error('Independent sessions currently support Codex and Claude');
                if (!sessionId) {
                    const codexSessionGrant = metadata.flavor === 'codex' && metadata.codexAccountProfileId
                        ? await deps.grant(parentSessionId) : undefined;
                    const result = await deps.spawn({ directory: task.directory ?? metadata.path, agent: metadata.flavor,
                        ...(metadata.flavor === 'codex' ? { model: metadata.currentModelCode,
                            effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(metadata.currentThoughtLevelCode ?? '')
                                ? metadata.currentThoughtLevelCode as SpawnSessionOptions['effort'] : undefined } : {}),
                        parentSessionId, codexSessionGrant, expectedCodexAccountProfileId: metadata.codexAccountProfileId, approvedNewDirectoryCreation: false });
                    if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : 'Choose an existing working directory');
                    sessionId = result.sessionId;
                    record.sessionId = sessionId;
                }
                const child = deps.findSession(sessionId);
                if (!child?.encryption) throw new Error('Child session encryption is unavailable');
                await deps.send(child, `${task.title}\n\n${task.prompt}`, `independent:${task.requestId}`, context?.permissionMode ?? (['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo'].includes(metadata.currentOperatingModeCode ?? '') ? metadata.currentOperatingModeCode : 'read-only'), context?.appendSystemPrompt);
                return { success: true, sessionId, title: task.title };
            } catch (error) {
                return { success: false, sessionId, title: task.title, error: error instanceof Error ? error.message : String(error) };
            }
        })();
        record.promise = promise;
        void promise.then(result => { record.result = result; record.promise = undefined; });
        return promise;
    };
}
