export function shouldInvalidateGitStatusOnActivityTransition(
    previousActive: boolean | undefined,
    nextActive: boolean
): boolean {
    return previousActive === false && nextActive === true;
}

export interface NotGitRefreshDecisionInput {
    hasConfirmedGitRepo: boolean;
    consecutiveNotGitDetections: number;
}

export interface NotGitRefreshDecision {
    action: 'preserve' | 'clear';
    nextConsecutiveNotGitDetections: number;
}

export function decideNotGitRefreshOutcome(
    input: NotGitRefreshDecisionInput
): NotGitRefreshDecision {
    const nextConsecutiveNotGitDetections = input.consecutiveNotGitDetections + 1;

    if (input.hasConfirmedGitRepo && input.consecutiveNotGitDetections === 0) {
        return {
            action: 'preserve',
            nextConsecutiveNotGitDetections,
        };
    }

    return {
        action: 'clear',
        nextConsecutiveNotGitDetections,
    };
}
