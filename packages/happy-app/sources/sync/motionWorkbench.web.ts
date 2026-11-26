/** PC Web access to the execution machine through the encrypted session RPC. */
import { z } from 'zod';
import { MotionWorkbenchErrorCodeSchema, MotionWorkbenchRequests, MotionWorkbenchResponses, type MotionWorkbenchErrorCode } from '@slopus/happy-wire';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { apiSocket } from './apiSocket';

export class MotionWorkbenchRpcError extends Error {
    constructor(readonly code: MotionWorkbenchErrorCode | 'UNAVAILABLE', message: string) { super(message); }
}

export async function motionWorkbenchRequest<K extends keyof typeof MotionWorkbenchRequests>(
    sessionId: string, method: K, input: z.input<(typeof MotionWorkbenchRequests)[K]>,
): Promise<z.infer<(typeof MotionWorkbenchResponses)[K]>> {
    if (!accountRuntimeCurrent()) throw new MotionWorkbenchRpcError('UNAVAILABLE', 'Account changed; reopen the project.');
    const request = MotionWorkbenchRequests[method].safeParse(input);
    if (!request.success) throw new MotionWorkbenchRpcError('INVALID_REQUEST', 'Invalid motion-project request.');
    let response: unknown;
    try { response = await apiSocket.sessionRPC(sessionId, method, request.data, { timeoutMs: method === 'motionWorkbenchOpen' || method === 'motionWorkbenchClose' ? 90_000 : 40_000 }); }
    catch { throw new MotionWorkbenchRpcError('UNAVAILABLE', 'The motion-project session is unavailable.'); }
    if (!accountRuntimeCurrent()) throw new MotionWorkbenchRpcError('UNAVAILABLE', 'Account changed; reopen the project.');
    const envelope = z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), value: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.object({ code: MotionWorkbenchErrorCodeSchema, message: z.string().max(2048) }) }),
    ]).safeParse(response);
    if (!envelope.success) throw new MotionWorkbenchRpcError('UNAVAILABLE', 'The editor returned an invalid response.');
    if (!envelope.data.ok) throw new MotionWorkbenchRpcError(envelope.data.error.code, envelope.data.error.message);
    const result = MotionWorkbenchResponses[method].safeParse(envelope.data.value);
    if (!result.success) throw new MotionWorkbenchRpcError('UNAVAILABLE', 'The editor returned an invalid response.');
    return result.data as z.infer<(typeof MotionWorkbenchResponses)[K]>;
}
