import { ConversationPrepareRequestSchema, type ConversationPrepareRequest, type ConversationPrepareResponse } from '@slopus/happy-wire';
import type { Metadata } from '@/api/types';

type CandidateMetadata = Metadata & { conversationRootSessionId?: string; continuationOfSessionId?: string };
type Configuration = Pick<ConversationPrepareResponse, 'model' | 'effort' | 'permissionMode'>;

/** Conversation candidates use their launch and archive, never delegated-task authority. */
export function createConversationPreparation(deps: {
    agent: 'codex' | 'antigravity'; sessionId(): string; metadata(): CandidateMetadata | null;
    prepare(request: Pick<ConversationPrepareRequest, 'model' | 'effort' | 'permissionMode'>,
        assertCurrent: (metadata?: Metadata) => void): Promise<Configuration>;
}) {
    return async (input: unknown): Promise<ConversationPrepareResponse> => {
        const request = ConversationPrepareRequestSchema.parse(input);
        const sessionId = deps.sessionId();
        const deadline = Date.now() + 70_000;
        let expired = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const assertCurrent = (candidate?: Metadata) => {
            if (expired || Date.now() >= deadline) throw new Error('Timed out preparing the conversation runtime');
            const metadata = (candidate ?? deps.metadata()) as CandidateMetadata | null;
            if (!metadata || deps.sessionId() !== sessionId || metadata.hostPid !== process.pid || request.expectedWorkerPid !== process.pid
                || metadata.flavor !== deps.agent || metadata.application || metadata.delegatedTask || metadata.sandbox?.enabled
                || ['archived', 'archiveRequested'].includes(metadata.lifecycleState ?? '')
                || metadata.parentSessionId !== request.sourceSessionId || metadata.crossAgentRequestId !== request.requestId
                || metadata.continuationOfSessionId !== request.sourceSessionId || metadata.conversationRootSessionId !== request.rootSessionId) {
                throw new Error('Conversation candidate worker or launch binding changed');
            }
            if (metadata.portableContext?.id !== request.contextId || metadata.portableContext.sha256 !== request.contextSha256) {
                throw new Error('Conversation candidate context changed');
            }
        };
        assertCurrent();
        try {
            const configuration = await Promise.race([
                deps.prepare({ model: request.model, effort: request.effort, permissionMode: request.permissionMode }, assertCurrent),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => { expired = true; reject(new Error('Timed out preparing the conversation runtime')); }, 70_000);
                }),
            ]);
            assertCurrent();
            if (configuration.permissionMode !== request.permissionMode) throw new Error('Conversation permission configuration was not confirmed');
            return { ready: true, agent: deps.agent, sessionId, hostPid: process.pid,
                rootSessionId: request.rootSessionId, sourceSessionId: request.sourceSessionId, requestId: request.requestId,
                contextId: request.contextId, contextSha256: request.contextSha256, ...configuration };
        } finally { if (timeout !== undefined) clearTimeout(timeout); }
    };
}
