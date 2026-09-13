import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '../../tools/knownTools';
import { useSetting } from '@/sync/storage';


export const EditView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    
    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(tool.input);
    if (parsed.success) {
        oldString = parsed.data.old_string || '';
        newString = parsed.data.new_string || '';
    }

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    oldText={oldString} 
                    newText={newString} 
                    fileName={parsed.success ? parsed.data.file_path : undefined}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        </>
    );
});