import type { Session } from './storageTypes';

export interface GitStatusSessionCandidate {
    sessionId: string;
    session: Session;
}

function getProjectKey(session: Session): string | null {
    const machineId = session.metadata?.machineId;
    const path = session.metadata?.path;
    if (!machineId || !path) {
        return null;
    }
    return `${machineId}:${path}`;
}

function isPreferredCandidate(
    candidate: GitStatusSessionCandidate,
    currentBest: GitStatusSessionCandidate
): boolean {
    if (candidate.session.active !== currentBest.session.active) {
        return candidate.session.active;
    }
    if (candidate.session.activeAt !== currentBest.session.activeAt) {
        return candidate.session.activeAt > currentBest.session.activeAt;
    }
    return false;
}

export function selectPreferredGitStatusSession(
    candidates: GitStatusSessionCandidate[],
    projectKey: string
): GitStatusSessionCandidate | null {
    const matchingCandidates = candidates.filter((candidate) => {
        if (!candidate.session.metadata?.path) {
            return false;
        }
        return getProjectKey(candidate.session) === projectKey;
    });

    if (matchingCandidates.length === 0) {
        return null;
    }

    return matchingCandidates.reduce((best, candidate) => {
        return isPreferredCandidate(candidate, best) ? candidate : best;
    });
}
