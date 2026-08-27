import * as React from 'react';
import { ToolViewProps } from './_all';
import { InlineFileEditBlock } from '@/components/tools/InlineFileEditBlock';
import { knownTools } from '@/components/tools/knownTools';
import { resolvePath } from '@/utils/pathUtils';

export const WriteView = React.memo<ToolViewProps>(({ tool, metadata, permissionFooter }) => {
    let contents = '';
    let filePath = 'file.txt';
    let fileName = 'file.txt';
    const parsed = knownTools.Write.input.safeParse(tool.input);
    if (parsed.success) {
        if (typeof parsed.data.content === 'string') {
            contents = parsed.data.content;
        }
        if (parsed.data.file_path) {
            filePath = resolvePath(parsed.data.file_path, metadata);
            fileName = parsed.data.file_path.split(/[\\/]/).pop() || parsed.data.file_path;
        }
    }

    return (
        <InlineFileEditBlock
            filePath={filePath}
            fileName={fileName}
            kindLabel="new"
            oldText=""
            newText={contents}
            permissionFooter={permissionFooter}
        />
    );
});
