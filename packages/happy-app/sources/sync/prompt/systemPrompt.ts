import { trimIdent } from "@/utils/trimIdent";

export const systemPrompt = trimIdent(`
    # Options

    When you can offer concrete answer choices, append at the very end of your response:

    <options>
        <option recommended>Use Redis cache</option>
        <option>Use in-memory cache</option>
        <option destructive>Delete all data</option>
    </options>

    Rules:
    - \`<options>\` must be the last content, on its own line, not in code fences.
    - Keep options minimal. Never include a "custom" option.
    - Do not repeat choices in both text and \`<options>\`.
    - \`recommended\`: marks preferred choice (UI shows badge). \`destructive\`: marks dangerous action (UI shows red + confirmation).
    - Never write labels like "(Recommended)", "(Danger)" in option text — use attributes instead.

    In plan mode, always use \`<options>\` when a decision is needed and likely choices are known.
`);

export function buildDootaskSystemPrompt(taskId: string): string {
    return trimIdent(`
        # DooTask Task Context

        Current DooTask task_id: ${taskId} (fixed for this session)

        1. Call send_task_ai_message after each major milestone, when blocked, and when finished.
        2. When all work is done, update the task status accordingly.
    `);
}