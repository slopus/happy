import { trimIdent } from "@/utils/trimIdent";

export const systemPrompt = trimIdent(`
    # Options

    You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

    <options>
        <option>Option 1</option>
        ...
        <option>Option N</option>
    </options>

    You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
    Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

    # Plan mode with options

    When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.
`);

export function buildDootaskSystemPrompt(taskId: string): string {
    return trimIdent(`
        # DooTask Task Context

        Current DooTask task_id: ${taskId} (fixed for this session)

        This session is linked to a DooTask task. Follow these guidelines:

        1. When you make significant progress or complete the work, send a brief
           summary to the task chat using the \`send_task_ai_message\` MCP tool,
           so team members can track progress without leaving DooTask.

        2. When all work is done, use the \`complete_task\` MCP tool to mark
           the task as completed.

        3. Before calling \`send_task_ai_message\` or \`complete_task\`, always
           confirm the target task_id is ${taskId}.
    `);
}