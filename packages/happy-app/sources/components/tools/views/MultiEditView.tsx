import * as React from 'react';
import { ToolViewProps } from './_all';
import { InlineFileEditBlock } from '@/components/tools/InlineFileEditBlock';
import { knownTools } from '../../tools/knownTools';
import { resolvePath } from '@/utils/pathUtils';

export const MultiEditView = React.memo<ToolViewProps>(({ tool, metadata, permissionFooter }) => {
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    let filePath = 'file.txt';
    let fileName = 'file.txt';

    const parsed = knownTools.MultiEdit.input.safeParse(tool.input);
    if (parsed.success) {
        if (parsed.data.edits) {
            edits = parsed.data.edits;
        }
        if (parsed.data.file_path) {
            filePath = resolvePath(parsed.data.file_path, metadata);
            fileName = parsed.data.file_path.split(/[\\/]/).pop() || parsed.data.file_path;
        }
    }

    if (edits.length === 0) {
        return null;
    }

    return (
        <InlineFileEditBlock
            filePath={filePath}
            fileName={fileName}
            kindLabel="edit"
            pairs={edits.map(edit => ({
                oldText: edit.old_string || '',
                newText: edit.new_string || '',
            }))}
            permissionFooter={permissionFooter}
        />
    );
});
