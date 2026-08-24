import * as React from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { InlineFileEditBlock } from '@/components/tools/InlineFileEditBlock';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { materializeUnifiedDiffPatch } from '@/utils/codexUnifiedDiff';

interface CodexPatchViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    permissionFooter?: React.ReactNode;
}

type CodexPatchEntry = {
    diff?: string;
    unified_diff?: string;
    type?: string;
    content?: string;
    move_path?: string | null;
    oldContent?: string;
    newContent?: string;
    old_content?: string;
    new_content?: string;
    kind?: {
        type?: string;
        move_path?: string | null;
    };
    add?: {
        content?: string;
    };
    modify?: {
        old_content?: string;
        new_content?: string;
    };
    delete?: {
        content?: string;
    };
};

function getPatchChanges(input: any): Record<string, CodexPatchEntry> | null {
    if (Array.isArray(input?.changes)) {
        return normalizePatchChangeList(input.changes);
    }
    if (input?.changes && typeof input.changes === 'object') {
        return input.changes as Record<string, CodexPatchEntry>;
    }
    if (Array.isArray(input?.fileChanges)) {
        return normalizePatchChangeList(input.fileChanges);
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object') {
        return input.fileChanges as Record<string, CodexPatchEntry>;
    }
    return null;
}

function normalizePatchChangeList(changes: unknown[]): Record<string, CodexPatchEntry> | null {
    const normalized: Record<string, CodexPatchEntry> = {};

    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const changeRecord = change as Record<string, unknown>;
        const path = typeof changeRecord.path === 'string' ? changeRecord.path : null;
        if (!path) {
            continue;
        }

        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as { type?: string; move_path?: string | null }
            : null;
        const type = typeof changeRecord.type === 'string' ? changeRecord.type : (kind?.type ?? null);
        const entry: CodexPatchEntry = {
            ...(kind ? { kind } : type ? { kind: { type, move_path: null } } : {}),
        };

        if (typeof changeRecord.diff === 'string') {
            entry.diff = changeRecord.diff;
        } else if (typeof changeRecord.unified_diff === 'string') {
            entry.unified_diff = changeRecord.unified_diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add as { content?: string };
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify as { old_content?: string; new_content?: string };
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete as { content?: string };
        }

        if (type === 'add' && typeof changeRecord.content === 'string') {
            entry.add = { content: changeRecord.content };
        }
        if (type === 'delete' && typeof changeRecord.content === 'string') {
            entry.delete = { content: changeRecord.content };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

type PatchInput =
    | { kind: 'patch'; patch: string }
    | { kind: 'pair'; oldText: string; newText: string };

function getPatchInput(change: CodexPatchEntry): PatchInput | null {
    if (typeof change.diff === 'string') {
        return { kind: 'patch', patch: change.diff };
    }
    if (typeof change.unified_diff === 'string') {
        return { kind: 'patch', patch: change.unified_diff };
    }
    if (change.modify) {
        return { kind: 'pair', oldText: change.modify.old_content || '', newText: change.modify.new_content || '' };
    }
    if (typeof change.oldContent === 'string' || typeof change.newContent === 'string') {
        return { kind: 'pair', oldText: change.oldContent || '', newText: change.newContent || '' };
    }
    if (typeof change.old_content === 'string' || typeof change.new_content === 'string') {
        return { kind: 'pair', oldText: change.old_content || '', newText: change.new_content || '' };
    }
    if (change.add) {
        return { kind: 'pair', oldText: '', newText: change.add.content || '' };
    }
    if (getPatchKindType(change) === 'add' && typeof change.content === 'string') {
        return { kind: 'pair', oldText: '', newText: change.content };
    }
    if (change.delete) {
        return { kind: 'pair', oldText: change.delete.content || '', newText: '' };
    }
    if (getPatchKindType(change) === 'delete' && typeof change.content === 'string') {
        return { kind: 'pair', oldText: change.content, newText: '' };
    }
    return null;
}

function getPatchKindType(change: CodexPatchEntry): string | null {
    return change.kind?.type ?? change.type ?? null;
}

function getPatchKindLabel(change: CodexPatchEntry): string | null {
    switch (getPatchKindType(change)) {
        case 'add':
            return 'new';
        case 'delete':
            return 'delete';
        case 'update':
            return getPatchMovePath(change) ? 'move' : 'edit';
        default:
            return null;
    }
}

function getPatchMovePath(change: CodexPatchEntry): string | null {
    return change.kind?.move_path ?? change.move_path ?? null;
}

export const CodexPatchView = React.memo<CodexPatchViewProps>(({ tool, metadata, permissionFooter }) => {
    const { input } = tool;
    const changes = getPatchChanges(input);

    const entries = changes ? Object.entries(changes) : [];

    if (entries.length === 0) {
        return null;
    }

    return (
        <>
            {entries.map(([file, change], index) => (
                <CodexPatchFileView
                    key={file}
                    file={file}
                    change={change}
                    metadata={metadata}
                    permissionFooter={index === entries.length - 1 ? permissionFooter : null}
                />
            ))}
        </>
    );
});

const CodexPatchFileView = React.memo(function CodexPatchFileView(props: {
    file: string;
    change: CodexPatchEntry;
    metadata: Metadata | null;
    permissionFooter?: React.ReactNode;
}) {
    const { file, change, metadata, permissionFooter } = props;

    const filePath = resolvePath(file, metadata);
    const diffInput = getPatchInput(change);
    const kindLabel = getPatchKindLabel(change);
    const rawMovePath = getPatchMovePath(change);
    const movePath = rawMovePath ? resolvePath(rawMovePath, metadata) : null;
    const fileName = file.split('/').pop() ?? file;
    const displayPatch = diffInput?.kind === 'patch'
        ? materializeUnifiedDiffPatch(diffInput.patch, file, getPatchKindType(change))
        : null;

    return (
        <InlineFileEditBlock
            filePath={filePath}
            fileName={fileName}
            kindLabel={kindLabel}
            movePath={movePath}
            patch={displayPatch ?? undefined}
            oldText={diffInput?.kind === 'pair' ? diffInput.oldText : undefined}
            newText={diffInput?.kind === 'pair' ? diffInput.newText : undefined}
            permissionFooter={permissionFooter}
        />
    );
});
