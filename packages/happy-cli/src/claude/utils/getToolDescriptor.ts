export function getToolDescriptor(toolName: string): { edit: boolean, exitPlan: boolean, dangerous: boolean } {
    if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') {
        return { edit: false, exitPlan: true, dangerous: false };
    }
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        return { edit: true, exitPlan: false, dangerous: true };
    }
    if (toolName === 'Bash') {
        return { edit: false, exitPlan: false, dangerous: true };
    }
    return { edit: false, exitPlan: false, dangerous: false };
}