import { BROWSER_STEP_REPORTING_INSTRUCTION } from "@/browser/browserStepReportingPrompt";
import { trimIdent } from "@/utils/trimIdent";

/**
 * Base system prompt shared across all configurations
 */
export const systemPrompt = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
    If the user explicitly asks you to archive, close, or end the current Happy chat session after finishing the task, complete the task first and then call "mcp__happy__archive_session".
    ${BROWSER_STEP_REPORTING_INSTRUCTION}
`))();
