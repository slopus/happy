export type AgentInputActionBarLayout = 'wrap' | 'scroll' | 'collapsed';

export type AgentInputActionBarActionFlags = Readonly<{
    showPermissionChip: boolean;
    hasProfile: boolean;
    hasEnvVars: boolean;
    hasAgent: boolean;
    hasMachine: boolean;
    hasPath: boolean;
    hasResume: boolean;
    hasFiles: boolean;
    hasStop: boolean;
}>;

export function getHasAnyAgentInputActions(flags: AgentInputActionBarActionFlags): boolean {
    return Boolean(
        flags.showPermissionChip ||
        flags.hasProfile ||
        flags.hasEnvVars ||
        flags.hasAgent ||
        flags.hasMachine ||
        flags.hasPath ||
        flags.hasResume ||
        flags.hasFiles ||
        flags.hasStop
    );
}

export function shouldShowPathAndResumeRow(actionBarLayout: AgentInputActionBarLayout): boolean {
    // Path/Resume live on a separate row only in the "wrap" action bar layout.
    // In "scroll" they fold into the first row; in "collapsed" they move into the popover menu.
    return actionBarLayout === 'wrap';
}

