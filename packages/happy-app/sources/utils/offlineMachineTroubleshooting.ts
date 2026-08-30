import type { MachineChoice } from '@/sync/machineChoices';
import type { SessionListItem } from '@/sync/storage';

export type OfflineMachineTroubleshooting = {
    machineName: string;
    projectName: string;
    happyHomeDir: string;
    aiPrompt: string;
    message: string;
};

function projectNameFromPath(path: string | null | undefined): string | null {
    const normalized = path?.trim().replace(/[/\\]+$/, '');
    if (!normalized) return null;
    return normalized.split(/[/\\]/).pop() || null;
}

/**
 * Builds the compact offline help shown when an account has machines but none are reachable.
 * The newest known project chooses the machine so the copyable AI prompt points at useful local
 * Happy logs instead of giving generic networking advice.
 */
export function buildOfflineMachineTroubleshooting(
    choices: readonly MachineChoice[],
    sessions: readonly SessionListItem[] | null,
): OfflineMachineTroubleshooting {
    const sortedSessions = (sessions ?? [])
        .filter((item): item is Exclude<SessionListItem, string> => typeof item !== 'string')
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

    let choice = [...choices].sort((left, right) => right.activeAt - left.activeAt)[0] ?? null;
    let session = null as (typeof sortedSessions)[number] | null;

    for (const candidate of sortedSessions) {
        const candidateChoice = choices.find((item) => item.machineIds.includes(candidate.metadata?.machineId ?? ''));
        if (!candidateChoice) continue;
        choice = candidateChoice;
        session = candidate;
        break;
    }

    const machineName = choice?.name?.trim() || 'this machine';
    const projectName = session?.metadata?.project?.name?.trim()
        || projectNameFromPath(session?.metadata?.path)
        || 'Happy';
    const happyHomeDir = choice?.happyMachine?.metadata?.happyHomeDir?.trim()
        || choice?.rigMachine?.metadata?.happyHomeDir?.trim()
        || session?.metadata?.happyHomeDir?.trim()
        || '~/.happy';
    const aiPrompt = `In ${happyHomeDir}, diagnose why Happy cannot reach "${machineName}" for project "${projectName}".`;

    return {
        machineName,
        projectName,
        happyHomeDir,
        aiPrompt,
        message: [
            '1. Wake the machine and check internet.',
            '2. Run `happy` again.',
            '3. Reopen Happy.',
            '',
            'AI prompt:',
            aiPrompt,
        ].join('\n'),
    };
}