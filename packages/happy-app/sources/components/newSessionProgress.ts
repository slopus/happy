// There is deliberately no 'canceling' phase. Stop hands the composer back at
// once and kills what it can without being watched, so a state meaning "waiting
// to finish stopping" would be a wait the user never has to sit through.
export type NewSessionStartPhase = 'worktree' | 'spawning' | 'opening';

/**
 * What the composer says while a session is being created. The dock stays up
 * with the keyboard through the whole flow, so every step names itself instead
 * of leaving one spinner to stand for all of them.
 */
export function resolveNewSessionProgressLabel({
    phase,
    agentName,
    picksWorkspaces,
}: {
    phase: NewSessionStartPhase | null | undefined;
    agentName: string;
    picksWorkspaces: boolean;
}): string | null {
    if (!phase) return null;
    if (phase === 'worktree') {
        return picksWorkspaces ? 'Creating workspace…' : 'Creating worktree…';
    }
    if (phase === 'spawning') {
        return `Starting ${agentName}…`;
    }
    return 'Opening session…';
}

export type NewSessionPrimaryAction = 'send' | 'stop' | 'busy' | 'idle';

/**
 * The one button at the end of the composer, which reads the same way as the
 * session composer's: it sends, and while the agent is being started it stops.
 */
export function resolveNewSessionPrimaryAction({
    canSubmit,
    phase,
    canCancel,
}: {
    canSubmit: boolean;
    phase: NewSessionStartPhase | null | undefined;
    canCancel: boolean;
}): NewSessionPrimaryAction {
    if (phase) {
        // Without somewhere to send the stop, the button reports the wait
        // rather than offering something it cannot do.
        return canCancel ? 'stop' : 'busy';
    }
    return canSubmit ? 'send' : 'idle';
}
