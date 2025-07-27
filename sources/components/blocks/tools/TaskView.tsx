import * as React from 'react';
import { ToolViewProps } from './_all';

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata }) => {
    // In the new architecture, children are rendered at the message level
    // This view just shows that it's a Task tool
    // The Task tool itself doesn't need special rendering since its children
    // are handled by the message tree structure
    return null;
});