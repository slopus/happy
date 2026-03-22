import { trimIdent } from "@/utils/trimIdent";

export const systemPrompt = trimIdent(`
    # Options

    When you can offer concrete answer choices, append at the very end of your response:

    <options>
        <option>Use Redis cache</option>
        <option>Use in-memory cache</option>
        <option destructive>Delete all data</option>
    </options>

    Rules:
    - \`<options>\` must be the last content, on its own line, not in code fences.
    - Keep options minimal. Never include a "custom" option.
    - Do not repeat choices in both text and \`<options>\`.
    - Order options from most recommended to least recommended — the first option should be the best choice.
    - \`destructive\`: marks dangerous action.
    - Never write labels like "(Recommended)", "(Danger)" in option text — rely on ordering for preference, \`destructive\` attribute for danger.
`);

export function buildDootaskSystemPrompt(taskId: string): string {
    return trimIdent(`
        # DooTask Task Context

        Current DooTask task_id: ${taskId} (fixed for this session)

        1. Call send_task_ai_message after each major milestone, when blocked, and when finished.
        2. When all work is done, update the task status accordingly.
    `);
}