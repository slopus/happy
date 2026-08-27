import * as React from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { InlineFileEditBlock } from '@/components/tools/InlineFileEditBlock';
import { Metadata } from '@/sync/storageTypes';
import { parseUnifiedDiff } from '@/utils/codexUnifiedDiff';
import { resolvePath } from '@/utils/pathUtils';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    permissionFooter?: React.ReactNode;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata, permissionFooter }) => {
    const { input } = tool;
    const patch = typeof input?.unified_diff === 'string' ? input.unified_diff : undefined;
    if (!patch) return null;

    const parsedName = parseUnifiedDiff(patch).fileName;
    const filePath = parsedName ? resolvePath(parsedName, metadata) : 'diff';
    const fileName = parsedName ? (parsedName.split('/').pop() ?? parsedName) : 'diff';

    return (
        <InlineFileEditBlock
            filePath={filePath}
            fileName={fileName}
            kindLabel="diff"
            patch={patch}
            permissionFooter={permissionFooter}
        />
    );
});
