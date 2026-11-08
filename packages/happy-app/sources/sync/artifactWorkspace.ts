import { z } from 'zod';
import { ArtifactChangedSchema, ArtifactRequests, ArtifactResponses, ArtifactRpcErrorSchema } from '@slopus/happy-wire';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { apiSocket } from './apiSocket';

export class ArtifactRpcError extends Error {
    constructor(readonly detail: z.infer<typeof ArtifactRpcErrorSchema>, readonly uncertain = false) { super(detail.message); }
}
/** Single user/event-triggered request. A timed-out mutation is inspected by operationId, never replayed automatically. */
export async function artifactRequest<K extends keyof typeof ArtifactRequests>(machineId: string, method: K, input: z.infer<(typeof ArtifactRequests)[K]>): Promise<z.infer<(typeof ArtifactResponses)[K]>> {
    if (!accountRuntimeCurrent()) throw new ArtifactRpcError({ code: 'UNAVAILABLE', message: '账号已切换，请重新打开作品。' });
    const parsed = ArtifactRequests[method].safeParse(input);
    if (!parsed.success) throw new ArtifactRpcError({code:'LIMIT_EXCEEDED',message:'Invalid or oversized artifact request'});
    const request = parsed.data;
    let response: unknown;
    try { response = await apiSocket.machineRPC(machineId, method, request); }
    catch { throw new ArtifactRpcError({ code: 'UNAVAILABLE', message: '版本服务不可用；若刚刚提交了修改，请按操作 ID 核查结果。' }, true); }
    if (!accountRuntimeCurrent()) throw new ArtifactRpcError({ code: 'UNAVAILABLE', message: '账号已切换，请重新打开作品。' }, true);
    const envelope = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: ArtifactRpcErrorSchema.optional() }).parse(response);
    if (!envelope.ok) {
        if (!envelope.error) throw new Error('Invalid artifact error response');
        throw new ArtifactRpcError(envelope.error);
    }
    return ArtifactResponses[method].parse(envelope.value) as z.infer<(typeof ArtifactResponses)[K]>;
}

/** Consumers refresh matching open artifacts once for a new sequence, and once on reconnect. */
export function artifactInvalidations(daemonState: unknown) {
    return z.object({ artifactChanges: z.array(ArtifactChangedSchema).max(64).optional() }).safeParse(daemonState).data?.artifactChanges ?? [];
}
