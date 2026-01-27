export function getToolDescriptor(toolName: string): { edit: boolean, exitPlan: boolean } {
    if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') {
        return { edit: false, exitPlan: true };
    }
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        return { edit: true, exitPlan: false };
    }
    return { edit: false, exitPlan: false };
}