import * as React from 'react';

export type SubagentActivityTooltipProps = React.PropsWithChildren<{
    id: string;
    visible: boolean;
    onDismiss: () => void;
}>;

/** Touch and native users reach the same information through the detail row. */
export function SubagentActivityTooltip(_props: SubagentActivityTooltipProps) {
    return null;
}
