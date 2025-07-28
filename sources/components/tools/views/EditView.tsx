import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { DiffView } from '@/components/diff/DiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';


export const EditView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbers = useSetting('showLineNumbers');
    
    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(tool.input);
    if (parsed.success) {
        oldString = trimIdent(parsed.data.old_string || '');
        newString = trimIdent(parsed.data.new_string || '');
    }

    return (
        <>
            <ToolSectionView>
                <DiffView 
                    oldText={oldString} 
                    newText={newString} 
                    wrapLines={false}
                    showLineNumbers={showLineNumbers}
                />
            </ToolSectionView>
        </>
    );
});