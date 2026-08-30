import type { MachineCodexAttachCandidate } from './codexAttachCandidates';

export function filterCodexAttachCandidates(
    candidates: MachineCodexAttachCandidate[],
    query: string,
): MachineCodexAttachCandidate[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return candidates;

    return candidates.filter((candidate) => [
        candidate.title,
        candidate.directory,
        candidate.machineName,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
}
