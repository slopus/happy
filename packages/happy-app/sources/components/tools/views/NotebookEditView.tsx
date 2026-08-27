import * as React from 'react';
import { ToolViewProps } from './_all';
import { InlineFileEditBlock } from '@/components/tools/InlineFileEditBlock';
import { knownTools } from '../../tools/knownTools';
import { resolvePath } from '@/utils/pathUtils';

export const NotebookEditView = React.memo<ToolViewProps>(({ tool, metadata, permissionFooter }) => {
    const parsed = knownTools.NotebookEdit.input.safeParse(tool.input);
    if (!parsed.success || typeof parsed.data.notebook_path !== 'string') {
        return null;
    }

    const notebookPath = parsed.data.notebook_path;
    const filePath = resolvePath(notebookPath, metadata);
    const fileName = notebookPath.split(/[\\/]/).pop() || notebookPath;
    const editMode = parsed.data.edit_mode ?? 'replace';
    const newSource = typeof parsed.data.new_source === 'string' ? parsed.data.new_source : '';

    return (
        <InlineFileEditBlock
            filePath={filePath}
            fileName={fileName}
            kindLabel={editMode === 'insert' ? 'new cell' : editMode === 'delete' ? 'delete cell' : 'edit cell'}
            oldText={editMode === 'delete' ? newSource : ''}
            newText={editMode === 'delete' ? '' : newSource}
            permissionFooter={permissionFooter}
        />
    );
});
