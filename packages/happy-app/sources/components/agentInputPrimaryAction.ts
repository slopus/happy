export type AgentInputPrimaryAction = 'send' | 'stop' | 'blocked' | 'idle';

export function resolveAgentInputPrimaryAction({
    hasComposerContent,
    isSendBlocked,
    isSendDisabled,
    showAbortButton,
    canAbort,
}: {
    hasComposerContent: boolean;
    isSendBlocked: boolean;
    isSendDisabled: boolean;
    showAbortButton: boolean;
    canAbort: boolean;
}): AgentInputPrimaryAction {
    // A blank composer while the agent is working is the one case where the
    // primary control is Stop. As soon as the user starts a follow-up, sending
    // takes priority so the next message can be queued without aborting work.
    if (showAbortButton && canAbort && !hasComposerContent && !isSendBlocked) {
        return 'stop';
    }
    if (isSendBlocked && hasComposerContent) {
        return 'blocked';
    }
    if (!isSendDisabled && hasComposerContent) {
        return 'send';
    }
    return 'idle';
}
