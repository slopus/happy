import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { readVoiceConfig, synthesize } from './synthesize';

interface ReadAloudRequest {
    text: string;
}

export type ReadAloudResponse =
    | { ok: true; audioBase64: string; mimeType: 'audio/wav' }
    | { ok: false; reason: 'not-configured' };

/**
 * Machine-scoped read-aloud for the app (fork feature, see docs/self-hosted-tts-plan.md).
 *
 * Always registered, even before `happy voice setup` ran: an unregistered
 * method only fails after the server's 15s reconnect grace window, and
 * reading the config per call means setup takes effect without a daemon
 * restart. Errors thrown here reach the app as `{ error }`.
 */
export function registerReadAloudHandler(rpcHandlerManager: RpcHandlerManager) {
    rpcHandlerManager.registerHandler<ReadAloudRequest, ReadAloudResponse>('read-aloud', async (params) => {
        const config = readVoiceConfig();
        if (!config) return { ok: false, reason: 'not-configured' };
        if (typeof params?.text !== 'string') throw new Error('text is required');
        logger.debug(`[read-aloud] synthesizing ${params.text.length} chars with ${config.voice}`);
        const wav = await synthesize(params.text, config.voice);
        return { ok: true, audioBase64: wav.toString('base64'), mimeType: 'audio/wav' };
    });
}
