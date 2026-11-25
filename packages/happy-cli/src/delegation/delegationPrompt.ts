const PARENT_DELEGATION_PROMPT = 'Paws delegation: At the first normal task in this parent session, call agent_roles with action="list" to discover its configured roles before deciding whether to delegate. Follow any explicit user role/executor choice first. Otherwise, automatic delegation is allowed only for a configured role with autoDelegate=true whose description fits the work; autoDelegate=false requires an explicit user request. Do not invent roles or substitute their configured executor/model. Save, change, or delete roles only when the user asks. Use delegate_task with roleId for new work and the returned taskId for revisions of that same task. Review returned work before integrating it. Do not repeatedly query status; the delegation call waits for an outcome.';

/** Inject once after native startup, and never give delegation instructions to a child. */
export function createDelegationPromptLifecycle({ delegatedChild }: { delegatedChild: boolean }) {
    let sent = false;
    return {
        getPrompt(): string | undefined {
            return delegatedChild || sent ? undefined : PARENT_DELEGATION_PROMPT;
        },
        markPromptSent(): void {
            sent = true;
        },
    };
}
