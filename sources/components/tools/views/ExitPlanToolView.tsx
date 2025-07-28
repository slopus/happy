import * as React from 'react';
import { ToolViewProps } from "./_all";
import { ToolSectionView } from '../../tools/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { knownTools } from '../../tools/knownTools';

export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool }) => {
    let plan = '<empty>'
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    if (parsed.success) {
        plan = parsed.data.plan ?? '<empty>';
    }
    return (
        <ToolSectionView>
            <MarkdownView markdown={plan} />
        </ToolSectionView>
    );
});