import * as React from 'react';
import { ToolViewProps } from './_all';
import { InlineFileEditBlock } from '@/components/tools/InlineFileEditBlock';
import { knownTools } from '../../tools/knownTools';
import { resolvePath } from '@/utils/pathUtils';


export const EditView = React.memo<ToolViewProps>(({ tool, metadata, permissionFooter }) => {
    let oldString = '';
    let newString = '';
    let filePath = 'file.txt';
    let fileName = 'file.txt';
    const parsed = knownTools.Edit.input.safeParse(tool.input);
    if (parsed.success) {
        oldString = parsed.data.old_string || '';
        newString = parsed.data.new_string || '';
        if (parsed.data.file_path) {
            filePath = resolvePath(parsed.data.file_path, metadata);
            fileName = parsed.data.file_path.split(/[\\/]/).pop() || parsed.data.file_path;
        }
    }

    return (
        <InlineFileEditBlock
            filePath={filePath}
            fileName={fileName}
            kindLabel="edit"
            oldText={oldString}
            newText={newString}
            permissionFooter={permissionFooter}
        />
    );
});
