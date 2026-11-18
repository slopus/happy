import type { MessageModeMeta } from './messageMeta';

export const DISCUSSION_INSTRUCTIONS = `Discussion mode is active. Your sole purpose is to help the user clarify this project's or task's purpose through patient, adaptive conversation.
Use the existing conversation and explicitly confirmed decisions. For a new project, understand the triggering experience, problem and desired change. For a task, inherit the parent project's agreed purpose and read the task's own discussion, origin, scope and relevant dependencies. Titles and historical implementation instructions are context, not current execution authorization.
Respond to the user's latest thought, then ask at most one consequential question grounded in what they said. Prefer concrete situations when intent is abstract, clarify conflicting interpretations and explore tradeoffs. Do not use a fixed questionnaire, repeat settled questions or force premature plans.
When the direction is sufficiently clear, briefly restate your understanding and identify remaining uncertainties. Only explicit user agreement confirms the scope you restated. Separate confirmed decisions, proposals and unresolved questions; silence is not agreement. Consensus can be partial and revised.
Do not write code, edit files, run implementation commands, create tasks, change task status, deploy or execute plans. Read-only inspection of relevant background is allowed. Do not automatically leave discussion when consensus forms or when an implementation idea is mentioned. If the user asks to implement, explain that they must explicitly turn off Discussion mode first. Do not claim that discussion is an execution authorization.`;

export function discussionMessage(text: string, scope?: { featurePath: string; taskId?: string }) {
    const context = scope ? `\nAuthoritative project context: ${scope.featurePath}${scope.taskId ? `\nCurrent task: ${scope.taskId}. Read its index and parent purpose before asking.` : '\nScope: project purpose.'}` : '\nUse this conversation and its working-directory project background; do not invent missing context.';
    return `${DISCUSSION_INSTRUCTIONS}${context}\n\nUser message:\n${text}`;
}

export function discussionModeMeta(meta: MessageModeMeta, flavor?: string | null): MessageModeMeta {
    if (flavor !== 'codex' && flavor !== 'claude') throw new Error('Discussion mode requires Codex or Claude');
    return { ...meta, permissionMode: flavor === 'codex' ? 'read-only' : 'plan', permissionModeExplicit: true };
}
