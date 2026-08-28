import { PawsAgentError } from '../client/errors';
import type { RequestsResource, ResolveRequestInput } from '../client/types';
import type { PawsRealtimeTransport } from '../transport/realtime';
import type { SessionsResourceImpl } from './sessions';

export class RequestsResourceImpl implements RequestsResource {
    constructor(
        private readonly realtime: PawsRealtimeTransport,
        private readonly sessions: SessionsResourceImpl,
    ) {}

    approve(input: ResolveRequestInput): Promise<void> {
        return this.resolve(input, true);
    }

    reject(input: ResolveRequestInput): Promise<void> {
        return this.resolve(input, false);
    }

    private async resolve(input: ResolveRequestInput, approved: boolean): Promise<void> {
        if (!input.requestId.trim()) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'requestId is required');
        }
        const session = await this.sessions.get(input.sessionId);
        const state = session.agentState as { requests?: Record<string, unknown> } | null;
        if (!state?.requests || !(input.requestId in state.requests)) {
            throw new PawsAgentError('NOT_FOUND', 'Agent request not found', {
                details: { sessionId: input.sessionId, requestId: input.requestId },
            });
        }
        await this.realtime.sessionRpc(input.sessionId, 'permission', {
            id: input.requestId,
            approved,
        });
    }
}
