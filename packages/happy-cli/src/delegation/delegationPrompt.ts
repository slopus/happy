const PARENT_DELEGATION_PROMPT = 'Paws delegation: At the first normal task in this parent session, call agent_roles with action="list" to discover configured roles before deciding whether to delegate. Follow any explicit user role/executor choice first. Otherwise, automatic delegation is allowed only for a configured role with autoDelegate=true whose description fits the work; autoDelegate=false requires an explicit user request. Do not invent roles or substitute their configured executor/model. Save, change, or delete roles only when the user asks; use create for a new stable ID and update/delete with an observed roleId. Creation does not execute. Use delegate_task with exactly one of roleId, a temporary route {agent, model?, effort?} for explicit one-off work without saving a role, or the returned taskId for revisions. Always provide intent="automatic" for your own role selection or intent="explicit" for the user\'s actual delegation request; this is your classification, not human approval evidence. The backend rejects automatic selection unless the saved role allows it; never claim explicit to bypass that rule. Temporary routes and revisions require explicit intent. Omitted model/effort use the target native defaults, never inherit the parent model/effort. Review returned work before integrating it. Do not repeatedly query status; the delegation call waits for an outcome.';

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
