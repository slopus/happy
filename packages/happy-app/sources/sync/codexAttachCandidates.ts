import { apiSocket } from './apiSocket';
import { sync } from './sync';

export type CodexAttachCandidate = {
    threadId: string;
    title: string;
    directory: string;
    createdAt: number;
    updatedAt: number;
};

export type MachineCodexAttachCandidate = CodexAttachCandidate & {
    machineId: string;
    machineName: string;
};

export async function listCodexAttachCandidates(
    machineId: string,
    existingThreadIds: string[],
): Promise<CodexAttachCandidate[]> {
    const response = await apiSocket.machineRPC<{ candidates: CodexAttachCandidate[] }, { existingThreadIds: string[] }>(
        machineId,
        'codex-list-attach-candidates',
        { existingThreadIds },
    );
    return response.candidates;
}

export async function attachCodexCandidate(
    machineId: string,
    threadId: string,
): Promise<{ type: 'success'; sessionId: string }> {
    const result = await apiSocket.machineRPC<{ type: 'success'; sessionId: string }, { threadId: string }>(
        machineId,
        'codex-attach-candidate',
        { threadId },
    );
    await sync.refreshSessions();
    return result;
}

export async function dismissCodexCandidate(machineId: string, threadId: string): Promise<void> {
    await apiSocket.machineRPC<{ type: 'success' }, { threadId: string }>(
        machineId,
        'codex-dismiss-attach-candidate',
        { threadId },
    );
}
