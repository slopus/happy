import { trimIdent } from '@/utils/trimIdent';
import type { ApprovalPolicy, ReasoningEffort, SandboxMode } from './codexAppServerTypes';

type ResumeThreadClient = {
    resumeThread: (opts: {
        threadId: string;
        cwd: string;
        model?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        mcpServers: Record<string, unknown>;
    }) => Promise<{ threadId: string; model: string }>;
};

type ResumeThreadSession = {
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
};

type ResumeThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

export async function resumeExistingThread(opts: {
    client: ResumeThreadClient;
    session: ResumeThreadSession;
    messageBuffer: ResumeThreadMessageBuffer;
    threadId: string;
    cwd: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    effort?: ReasoningEffort;
    mcpServers: Record<string, unknown>;
}): Promise<{ threadId: string; model: string }> {
    try {
        const resumedThread = await opts.client.resumeThread({
            threadId: opts.threadId,
            cwd: opts.cwd,
            model: opts.model,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            effort: opts.effort,
            mcpServers: opts.mcpServers,
        });

        opts.session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            codexThreadId: resumedThread.threadId,
        }));
        opts.messageBuffer.addMessage(`Resumed thread ${trimIdent(resumedThread.threadId)}`, 'status');
        opts.session.sendSessionEvent({
            type: 'message',
            message: `Resumed Codex thread ${resumedThread.threadId}`,
        });

        return resumedThread;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resume Codex thread ${opts.threadId}: ${reason}`);
    }
}
